import http from "node:http";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";

const env = process.env;

const config = {
  host: env.OPENCODE_PROXY_HOST ?? "127.0.0.1",
  port: Number(env.OPENCODE_PROXY_PORT ?? 4097),
  workspace: env.OPENCODE_WORKSPACE ?? process.cwd(),
  model: env.OPENCODE_MODEL,
  directUrl: env.OPENCODE_URL,
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
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return true;
    const res2 = await fetch(`${baseUrl}/global/health`, {
      headers: { Authorization: basicAuth(), Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
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
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// OpenCode V2 routes accept a flat `directory` query param (or the
// `x-opencode-directory` header). `location[directory]=...` is NOT a valid
// shape and is rejected by the server.
function locationQuery() {
  const params = new URLSearchParams();
  params.set("directory", config.workspace);
  return params.toString();
}

async function listModels(baseUrl) {
  const data = await requestJson(baseUrl, `/api/model?${locationQuery()}`);
  return data.data ?? [];
}

async function createSession(baseUrl, modelRef) {
  const body = {
    agent: "default",
    location: { directory: config.workspace },
  };
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
  // Body shape per v2.session.prompt: { id, text, files, agents, skills?,
  // metadata?, delivery?, resume? } — there is NO nested `prompt` object.
  await requestJson(baseUrl, `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST",
    body: {
      id: messageId,
      text: promptText,
      files: [],
      agents: [],
      delivery: "steer",
    },
  });

  const textReceived = new Set();
  let finishReason = "stop";
  let stepTokens = null;

  try {
    for await (const event of stream) {
      if (!event) break;
      const type = event.type;
      const props = event.properties || {};
      // Only react to events for our session; ignore global noise.
      if (props.sessionID && props.sessionID !== sessionId) continue;

      switch (type) {
        case "session.next.text.delta": {
          const textId = props.textID || props.id;
          if (!textReceived.has(textId)) {
            textReceived.add(textId);
            yield { type: "delta", text: props.delta ?? "" };
          }
          break;
        }
        case "session.next.text.ended": {
          const textId = props.textID || props.id;
          if (!textReceived.has(textId)) {
            textReceived.add(textId);
            yield { type: "delta", text: props.text ?? "" };
          }
          break;
        }
        case "session.next.step.ended": {
          finishReason = props.finish ?? "stop";
          stepTokens = props.tokens ?? null;
          // A turn may run multiple steps; keep consuming until idle.
          break;
        }
        case "session.next.reasoning.delta": {
          // Reasoning content is not surfaced as chat text; ignore.
          break;
        }
        case "session.idle": {
          let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
          if (stepTokens) {
            usage = {
              prompt_tokens: stepTokens.input ?? 0,
              completion_tokens: stepTokens.output ?? 0,
              total_tokens: (stepTokens.input ?? 0) + (stepTokens.output ?? 0),
            };
          }
          yield { type: "finish", finishReason, usage };
          return;
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

  yield { type: "finish", finishReason, usage: stepTokens ? {
    prompt_tokens: stepTokens.input ?? 0,
    completion_tokens: stepTokens.output ?? 0,
    total_tokens: (stepTokens.input ?? 0) + (stepTokens.output ?? 0),
  } : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
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

function openaiChatCompletionResponse(id, model, content, finishReason, usage) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content },
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
      for await (const item of runCompletion(base, modelRef, promptText, signal)) {
        if (item.type === "delta") fullText += item.text;
        else if (item.type === "finish") { finishReason = item.finishReason; usage = item.usage; }
      }
      const response = openaiChatCompletionResponse(
        `chatcmpl-${randomBytes(12).toString("hex")}`,
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