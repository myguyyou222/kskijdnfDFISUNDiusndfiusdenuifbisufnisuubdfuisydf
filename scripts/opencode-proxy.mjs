import http from "node:http";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";

const env = process.env;

const config = {
  host: env.OPENCODE_PROXY_HOST ?? "127.0.0.1",
  port: Number(env.OPENCODE_PROXY_PORT ?? 4097),
  // `||` (not `??`): an empty OPENCODE_WORKSPACE in .env must fall back to cwd,
  // otherwise sessions are created with directory:"" and the server 500s.
  workspace: env.OPENCODE_WORKSPACE || process.cwd(),
  model: env.OPENCODE_MODEL || undefined,
  directUrl: env.OPENCODE_URL || undefined,
  tailnet: env.TAILSCALE_TAILNET || "-",
  tailscaleApiKey: env.TAILSCALE_API_KEY,
  runnerTag: env.OPENCODE_RUNNER_TAG ?? "tag:opencode-runner",
  username: env.OPENCODE_SERVER_USERNAME ?? "opencode",
  password: env.OPENCODE_SERVER_PASSWORD,
  proxyApiKey: env.OPENCODE_PROXY_API_KEY,
  discoveryTtlMs: Number(env.OPENCODE_DISCOVERY_TTL_MS ?? 30000),
  requestTimeoutMs: Number(env.OPENCODE_REQUEST_TIMEOUT_MS ?? 1800000),
  runnerPort: Number(env.OPENCODE_RUNNER_PORT ?? 4096),
};

let runnerCache = { baseUrl: null, expires: 0 };

function basicAuth() {
  const token = Buffer.from(`${config.username}:${config.password}`).toString("base64");
  return `Basic ${token}`;
}

function buildBaseUrl(ip) {
  return `http://${ip}:${config.runnerPort}`;
}

async function tailscaleDevices() {
  if (!config.tailnet || !config.tailscaleApiKey) {
    throw new Error("Tailscale configuration missing");
  }
  const auth = Buffer.from(`${config.tailscaleApiKey}:`).toString("base64");
  const url = `https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(config.tailnet)}/devices`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`Tailscale API error: ${res.status}`);
  }
  return res.json();
}

function selectRunner(devices) {
  const candidates = (devices.devices ?? [])
    .filter(d => d.online !== false)
    .filter(d => (d.tags ?? []).includes(config.runnerTag))
    .filter(d => (d.hostname ?? d.name ?? "").startsWith("opencode-"))
    .filter(d => (d.addresses ?? []).some(a => a.includes(".") && !a.includes(":")))
    .map(d => ({
      ip: d.addresses.find(a => a.includes(".") && !a.includes(":")),
      lastSeen: new Date(d.lastSeen).getTime(),
    }))
    .filter(d => d.ip)
    .sort((a, b) => b.lastSeen - a.lastSeen);
  return candidates[0] ?? null;
}

async function healthCheck(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: basicAuth(), Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) return true;
    const res2 = await fetch(`${baseUrl}/global/health`, {
      headers: { Authorization: basicAuth(), Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    return res2.ok;
  } catch {
    return false;
  }
}

async function discoverRunner(force = false) {
  if (!force && runnerCache.baseUrl && runnerCache.expires > Date.now()) {
    if (await healthCheck(runnerCache.baseUrl)) return runnerCache.baseUrl;
  }
  if (config.directUrl) {
    const base = config.directUrl.replace(/\/+$/, "");
    if (await healthCheck(base)) {
      runnerCache.baseUrl = base;
      runnerCache.expires = Date.now() + config.discoveryTtlMs;
      return base;
    }
    throw new Error("Direct OpenCode URL unhealthy");
  }
  if (!config.tailnet || !config.tailscaleApiKey) {
    throw new Error("No OpenCode target configured");
  }
  const devices = await tailscaleDevices();
  const runner = selectRunner(devices);
  if (!runner) throw new Error("No suitable OpenCode runner found");
  const base = buildBaseUrl(runner.ip);
  if (!(await healthCheck(base))) throw new Error("Runner health check failed");
  runnerCache.baseUrl = base;
  runnerCache.expires = Date.now() + config.discoveryTtlMs;
  return base;
}

async function requestJson(baseUrl, path, options = {}) {
  const headers = {
    Authorization: basicAuth(),
    Accept: "application/json",
    "Content-Type": "application/json",
    ...options.headers,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    if (process.env.OPENCODE_DEBUG) console.log(`[debug] ${options.method ?? "GET"} ${path}`, JSON.stringify(options.body ?? ""));
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text();
      if (process.env.OPENCODE_DEBUG) console.log(`[debug] -> ${res.status}`, text.slice(0, 300));
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    // 204 / empty body (e.g. POST /api/session/{id}/wait) — nothing to parse.
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// OpenCode V2 routes accept a flat `directory` query param (or the
// `x-opencode-directory` header). `location[directory]=...` is NOT a valid
// shape and is rejected by the server. We deliberately send no filter: the
// server scopes sessions to ITS workdir, and the proxy's local cwd does not
// exist there. Per-session filtering happens client-side on sessionID.
function locationQuery() {
  return "";
}

async function listModels(baseUrl) {
  const data = await requestJson(baseUrl, `/api/model?${locationQuery()}`);
  return data.data ?? [];
}

async function createSession(baseUrl, modelRef) {
  // NOTE: do NOT send `location.directory` — the proxy's local cwd does not
  // exist on the remote runner, and the agent loop 500s on prompts for
  // sessions rooted at a nonexistent directory. Omitting `location` lets the
  // server use its own workdir.
  // NOTE 2: agent MUST be "build" (a real agent id). The name "default" is
  // accepted at session creation but matches no agent, so EVERY model-driven
  // tool call (write/read/bash/glob/...) fails server-side with "Unable to
  // ...". Verified 2026-09-12 on opencode-ai@1.18.30 local `serve`: "default"
  // session -> write/bash/read/glob all error; "build" session ->
  // write/bash succeed (direct /session/{id}/shell bypass works either way).
  const body = { agent: "build" };
  if (modelRef) body.model = modelRef;
  const res = await requestJson(baseUrl, `/api/session`, {
    method: "POST",
    body,
  });
  return res.data.id;
}

function resolveModelRef(requestModel, models) {
  if (config.model) {
    const m = models.find(m => m.id === config.model);
    if (m) return { id: m.id, providerID: m.providerID };
  }
  if (requestModel) {
    const m = models.find(m => m.id === requestModel);
    if (m) return { id: m.id, providerID: m.providerID };
    const prefixed = requestModel.replace(/^opencode\//, "");
    const m2 = models.find(m => m.id === prefixed);
    if (m2) return { id: m2.id, providerID: m2.providerID };
  }
  // Model.Info has no status/enabled fields — pick the first available model.
  const first = models.find(m => m.id);
  if (first) return { id: first.id, providerID: first.providerID };
  throw new Error("No available model");
}

function messagesToPrompt(messages) {
  return messages.map(m => {
    const role = (m.role ?? "user").toUpperCase();
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content.map(c => c.type === "text" ? c.text : "").join("");
    }
    return `${role}: ${text}`;
  }).join("\n\n");
}

function generateMessageId() {
  return `msg_${randomBytes(12).toString("hex")}`;
}

// The V2 event stream is a single global route: GET /api/event. It is
// filtered by the `directory` query param (flat shape, not
// `location[directory]=...`). Events are SSE lines whose `data:` field is a
// JSON-encoded envelope: { id, type, properties }. There is no per-session
// event route and no `after` cursor — the stream is live-only with no replay.
function openEventStream(baseUrl, signal) {
  const queue = [];
  let waiters = [];
  let done = false;
  let error = null;

  const url = `${baseUrl}/api/event?${locationQuery()}`;

  const readerPromise = (async () => {
    try {
      const res = await fetch(url, {
        headers: { Authorization: basicAuth(), Accept: "text/event-stream" },
        signal,
      });
      if (!res.ok) throw new Error(`Event stream error: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let data = "";
      while (true) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            data += (data ? "\n" : "") + line.slice(6);
          } else if (line === "") {
            if (data) {
              let evt;
              try { evt = JSON.parse(data); } catch { evt = null; }
              data = "";
              if (evt) enqueue(evt);
            }
          }
        }
      }
    } catch (e) {
      error = e;
    } finally {
      done = true;
      wake();
    }
  })();

  function enqueue(evt) {
    if (waiters.length) {
      const w = waiters.shift();
      w.resolve({ value: evt, done: false });
    } else {
      queue.push(evt);
    }
  }
  function wake() {
    for (const w of waiters) w.resolve({ value: null, done: true });
    waiters = [];
  }
  function next() {
    if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
    if (done) return error ? Promise.reject(error) : Promise.resolve({ value: null, done: true });
    return new Promise(resolve => waiters.push({ resolve }));
  }
  function returnFn() {
    done = true;
    wake();
    // Drain/await the background fetch so it can be cancelled by the
    // caller's AbortSignal rather than lingering as a floating promise.
    return readerPromise.then(() => ({ value: null, done: true }));
  }
  return {
    next,
    return: returnFn,
    [Symbol.asyncIterator]() { return this; },
  };
}

async function* runCompletion(baseUrl, modelRef, promptText, signal) {
  const sessionId = await createSession(baseUrl, modelRef);
  const messageId = generateMessageId();

  // Open the global event stream BEFORE posting the prompt so no execution
  // events are missed (the stream is volatile: events during disconnection
  // are lost). We filter to our sessionID once we have it.
  const stream = openEventStream(baseUrl, signal);

  // Durably admit the user input and schedule agent-loop execution.
  // Body shape per the live 1.18.30 spec (v2.session.prompt): the text lives in a
  // REQUIRED nested `prompt` object: { id?, prompt: { text, files?, agents? },
  // delivery?, resume? } (additionalProperties: false). A top-level `text` is
  // rejected with a 500 ("Unexpected server error").
  await requestJson(baseUrl, `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST",
    body: {
      id: messageId,
      prompt: {
        text: promptText,
        files: [],
        agents: [],
      },
      delivery: "steer",
    },
  });

  const textReceived = new Set();
  let finishReason = "stop";
  // Usage accumulates across ALL steps: multi-step turns (finish=tool-calls ->
  // next step.started -> finish=stop) carry per-step tokens on each step.ended.
  let usageInput = 0, usageOutput = 0, usageCacheRead = 0, usageCacheWrite = 0;
  // OPTION A read-only tool_calls mirror: OpenCode executes tools server-side
  // (there is no function-invocation endpoint), so the proxy surfaces each
  // native call as an OpenAI tool_call once its input is complete
  // (session.next.tool.called). Results are informational only — they were
  // already consumed by the agent loop and cannot be sent back.
  // Per OpenAI semantics one tool_call per index; callIDs are unique per call.
  const toolCalls = [];
  const toolResults = new Map(); // callID -> result text
  let sawToolCallsStep = false;
  let ended = false;

  try {
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      // After step.ended there is no `session.idle` event on 1.18.30 and its
      // /wait route 503s forever; treat a quiet gap after a finished step as
      // turn completion (multi-step turns restart within the settle window).
      const step = ended
        ? await Promise.race([
            iterator.next().then(r => ({ event: r.value, done: r.done })),
            new Promise(r => setTimeout(() => r({ idle: true }), 2000)),
          ])
        : await iterator.next().then(r => ({ event: r.value, done: r.done }));
      if (step.idle) break;
      const event = step.event;
      if (step.done || !event) break;
      const type = event.type;
      // Live 1.18.30 envelopes carry the payload in `data`.
      const props = event.data || {};
      // Only react to events for our session; ignore global noise.
      if (props.sessionID && props.sessionID !== sessionId) continue;

      switch (type) {
        case "session.next.step.started": {
          ended = false;
          break;
        }
        case "session.next.text.delta": {
          // Mark the textID seen AND stream the delta. text.ended later
          // repeats the full text, which must then be skipped (else every
          // token is doubled).
          if (props.textID) textReceived.add(props.textID);
          yield { type: "delta", text: props.delta ?? "" };
          break;
        }
        case "session.next.text.ended": {
          // text.ended repeats the full text already streamed via deltas —
          // only emit when no delta was seen for this textID (else clients
          // see every token twice, e.g. "LIVEPROXY" + "-OK" -> truncated).
          const textId = props.textID || props.id;
          if (textId && !textReceived.has(textId)) {
            textReceived.add(textId);
            yield { type: "delta", text: props.text ?? "" };
          }
          break;
        }
        case "session.next.step.ended": {
          // A step ending with finish=tool-calls is NOT turn end: the agent
          // loop continues with a new step.started (tool results already fed
          // back server-side). Only the 2s quiet gap after the FINAL step ends
          // the turn. Aggregate usage across every step.
          finishReason = props.finish ?? "stop";
          if (finishReason === "tool-calls") sawToolCallsStep = true;
          const t = props.tokens ?? {};
          usageInput += t.input ?? 0;
          usageOutput += t.output ?? 0;
          usageCacheRead += t.cache?.read ?? 0;
          usageCacheWrite += t.cache?.write ?? 0;
          ended = true;
          break;
        }
        case "session.next.tool.called": {
          // Tool input is complete here (input.* deltas are pre-execution
          // partials — do not stream those). Mirror as one OpenAI tool_call.
          if (props.callID && props.tool && !toolCalls.some(c => c.id === props.callID)) {
            toolCalls.push({
              id: props.callID,
              type: "function",
              function: {
                name: props.tool,
                arguments: JSON.stringify(props.input ?? {}),
              },
            });
            yield {
              type: "tool_call",
              toolCall: toolCalls[toolCalls.length - 1],
              index: toolCalls.length - 1,
            };
          }
          break;
        }
        case "session.next.tool.success": {
          if (props.callID) {
            const parts = Array.isArray(props.content) ? props.content : [];
            const text = parts
              .map(c => typeof c?.text === "string" ? c.text : JSON.stringify(c))
              .join("");
            const extra = props.structured && Object.keys(props.structured).length
              ? `\n(structured: ${JSON.stringify(props.structured)})`
              : "";
            toolResults.set(props.callID, text + extra);
          }
          break;
        }
        case "session.next.tool.failed": {
          if (props.callID) {
            toolResults.set(props.callID, `Error: ${props.error?.message ?? "tool call failed"}`);
          }
          break;
        }
        case "session.next.reasoning.delta": {
          // Reasoning content is not surfaced as chat text; ignore.
          break;
        }
        case "session.error": {
          throw new Error(props.error?.message ?? "OpenCode session error");
        }
        case "session.next.step.failed": {
          throw new Error(props.error?.message ?? "OpenCode step failed");
        }
        default:
          break;
      }
    }
  } finally {
    if (stream.return) stream.return();
  }

  // finish_reason mirrors OpenAI: "tool_calls" when the turn used native tools.
  // Exception: a turn whose steps ALL ended stop (no tool-calls step seen)
  // keeps "stop" even if a stray tool.called arrived without its step
  // sequence completing. Track via sawToolCallsStep below.
  if (finishReason !== "error" && toolCalls.length > 0 && sawToolCallsStep) {
    finishReason = "tool_calls";
  }
  const usage = {
    prompt_tokens: usageInput,
    completion_tokens: usageOutput,
    total_tokens: usageInput + usageOutput,
  };
  yield { type: "finish", finishReason, usage, toolCalls, toolResults };
}

function openaiModelList(models) {
  return {
    object: "list",
    data: models.map(m => ({
      id: m.id,
      object: "model",
      created: Math.floor(m.time?.released ?? Date.now() / 1000),
      owned_by: "opencode",
      permission: [],
    })),
  };
}

function openaiChatCompletionChunk(id, model, delta, finishReason) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
    }],
  };
}

function openaiChatCompletionResponse(id, model, content, finishReason, usage, toolCalls = [], toolResults = new Map()) {
  const message = { role: "assistant", content };
  if (toolCalls.length > 0) {
    // Read-only mirror: results ride along as a trailing human-readable block
    // (the calls already executed server-side; there is no client round-trip).
    message.tool_calls = toolCalls;
    const results = toolCalls.map(c => {
      const r = toolResults.get(c.id);
      return `Result of ${c.function.name} (${c.id}):\n${r ?? "(no result captured)"}`;
    });
    message.content = [content, ...results].filter(Boolean).join("\n\n");
  }
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    usage,
  };
}

function openaiCompletionResponse(id, model, text, finishReason, usage) {
  return {
    id,
    object: "text_completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      text,
      finish_reason: finishReason,
    }],
    usage,
  };
}

async function handleModels(req, res) {
  try {
    const base = await discoverRunner();
    const models = await listModels(base);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(openaiModelList(models)));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: e.message, type: "upstream_error" } }));
  }
}

function createRequestSignal(req) {
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  return controller.signal;
}

async function handleChatCompletions(req, res) {
  const body = await readBody(req);
  const stream = body.stream === true;
  const model = body.model ?? config.model;
  const promptText = messagesToPrompt(body.messages ?? []);
  const signal = createRequestSignal(req);
  try {
    const base = await discoverRunner();
    const models = await listModels(base);
    const modelRef = resolveModelRef(body.model, models);
    const runId = `chatcmpl-${randomBytes(12).toString("hex")}`;
    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(openaiChatCompletionChunk(runId, model, { role: "assistant", content: "" }, null))}\n\n`);
      for await (const item of runCompletion(base, modelRef, promptText, signal)) {
        if (item.type === "delta") {
          res.write(`data: ${JSON.stringify(openaiChatCompletionChunk(runId, model, { content: item.text }, null))}\n\n`);
        } else if (item.type === "tool_call") {
          // One chunk per native call, arguments complete (no pre-execution
          // input-delta streaming). Mirrors OpenAI's tool_calls delta shape.
          res.write(`data: ${JSON.stringify(openaiChatCompletionChunk(runId, model, { tool_calls: [{ index: item.index, id: item.toolCall.id, type: "function", function: item.toolCall.function }] }, null))}\n\n`);
        } else if (item.type === "finish") {
          res.write(`data: ${JSON.stringify(openaiChatCompletionChunk(runId, model, {}, item.finishReason))}\n\n`);
        }
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      let fullText = "";
      let finishReason = "stop";
      let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      let toolCalls = [];
      let toolResults = new Map();
      for await (const item of runCompletion(base, modelRef, promptText, signal)) {
        if (item.type === "delta") fullText += item.text;
        else if (item.type === "finish") { finishReason = item.finishReason; usage = item.usage; toolCalls = item.toolCalls ?? []; toolResults = item.toolResults ?? new Map(); }
      }
      const response = openaiChatCompletionResponse(
        `chatcmpl-${randomBytes(12).toString("hex")}`,
        model,
        fullText,
        finishReason,
        usage,
        toolCalls,
        toolResults
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    }
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: e.message, type: "upstream_error" } }));
    } else {
      res.end();
    }
  }
}

async function handleCompletions(req, res) {
  const body = await readBody(req);
  const stream = body.stream === true;
  const model = body.model ?? config.model;
  const prompt = typeof body.prompt === "string" ? body.prompt : Array.isArray(body.prompt) ? body.prompt.join("") : "";
  const signal = createRequestSignal(req);
  try {
    const base = await discoverRunner();
    const models = await listModels(base);
    const modelRef = resolveModelRef(body.model, models);
    const runId = `cmpl-${randomBytes(12).toString("hex")}`;
    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ id: runId, object: "text_completion.chunk", created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, text: "", finish_reason: null }] })}\n\n`);
      for await (const item of runCompletion(base, modelRef, prompt, signal)) {
        if (item.type === "delta") {
          res.write(`data: ${JSON.stringify({ id: runId, object: "text_completion.chunk", created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, text: item.text, finish_reason: null }] })}\n\n`);
        } else if (item.type === "finish") {
          res.write(`data: ${JSON.stringify({ id: runId, object: "text_completion.chunk", created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, text: "", finish_reason: item.finishReason }] })}\n\n`);
        }
      }
      res.end();
    } else {
      let fullText = "";
      let finishReason = "stop";
      let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      for await (const item of runCompletion(base, modelRef, prompt, signal)) {
        if (item.type === "delta") fullText += item.text;
        else if (item.type === "finish") { finishReason = item.finishReason; usage = item.usage; }
      }
      const response = openaiCompletionResponse(
        `cmpl-${randomBytes(12).toString("hex")}`,
        model,
        fullText,
        finishReason,
        usage
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    }
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: e.message, type: "upstream_error" } }));
    } else {
      res.end();
    }
  }
}

async function handleHealth(req, res) {
  try {
    const base = await discoverRunner();
    const healthy = await healthCheck(base);
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ healthy, runner: base }));
  } catch {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ healthy: false }));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function corsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const server = http.createServer(async (req, res) => {
  corsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (config.proxyApiKey) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${config.proxyApiKey}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unauthorized", type: "auth_error" } }));
      return;
    }
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/health") {
    await handleHealth(req, res);
  } else if (url.pathname === "/v1/models" && req.method === "GET") {
    await handleModels(req, res);
  } else if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    await handleChatCompletions(req, res);
  } else if (url.pathname === "/v1/completions" && req.method === "POST") {
    await handleCompletions(req, res);
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found", type: "not_found" } }));
  }
});

server.listen(config.port, config.host, () => {
  console.log(`OpenCode proxy listening on http://${config.host}:${config.port}`);
});