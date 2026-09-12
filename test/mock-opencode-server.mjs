import http from "node:http";

// Mock OpenCode V2 server implementing ONLY the routes the proxy calls:
//   GET  /api/health
//   GET  /api/model
//   POST /api/session
//   POST /api/session/{id}/prompt   -> JSON admission receipt
//   GET  /api/event                 -> global SSE stream
//
// Shapes verified against a LIVE opencode-ai@1.18.30 server (2026-09):
//  - prompt body REQUIRES a nested `prompt` object: { id?, prompt: { text,
//    files?, agents? }, delivery?, resume? } (additionalProperties: false).
//    A top-level `text` is rejected with HTTP 500.
//  - event envelopes carry the payload in `data` (NOT `properties`).
//  - there is NO `session.idle` event; turn completion = `step.ended`
//    (finish + tokens) with no follow-up `step.started`.

const PORT = 4096;
const USERNAME = "opencode";
const PASSWORD = "test-password";
const stepTokens = { input: 12, output: 34 };

const SESSIONS = new Map();          // sessionID -> session
const PENDING = new Map();           // sessionID -> { msgId, text }
let messageIdSeq = 0;
let sessionIdSeq = 0;
let eventWaiters = [];               // [{ resolve }]

function basicAuth(req) {
  const h = req.headers.authorization || "";
  return h === "Basic " + Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64");
}

function readBody(req) {
  return new Promise(resolve => {
    let data = "";
    req.on("data", c => data += c);
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (!basicAuth(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  // GET /api/health
  if (url.pathname === "/api/health" && req.method === "GET") {
    return res.end(JSON.stringify({ healthy: true }));
  }

  // GET /api/model
  if (url.pathname === "/api/model" && req.method === "GET") {
    return res.end(JSON.stringify({
      location: { directory: "/mock-workspace" },
      data: [
        { id: "anthropic/claude-sonnet-4-5", modelID: "claude-sonnet-4-5", providerID: "anthropic", name: "Claude Sonnet 4.5", time: { released: 1700000000 } },
        { id: "openai/gpt-4o", modelID: "gpt-4o", providerID: "openai", name: "GPT-4o", time: { released: 1690000000 } },
      ],
    }));
  }

  // POST /api/session
  if (url.pathname === "/api/session" && req.method === "POST") {
    const body = await readBody(req);
    const id = `ses_${(sessionIdSeq++).toString(16).padStart(8, "0")}`;
    const session = { id, agent: body.agent || "default", model: body.model || null };
    SESSIONS.set(id, session);
    return res.end(JSON.stringify({ data: session }));
  }

  // POST /api/session/{id}/prompt -> admission receipt JSON, NOT SSE.
  const promptMatch = url.pathname.match(/^\/api\/session\/(ses_[0-9a-f]+)\/prompt$/);
  if (promptMatch && req.method === "POST") {
    const sid = promptMatch[1];
    const body = await readBody(req);
    if (!SESSIONS.has(sid)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Session not found" }));
    }
    // Validate the LIVE 1.18.30 shape: REQUIRED nested `prompt`, no top-level text.
    if (typeof body.prompt?.text !== "string" || typeof body.text === "string") {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ name: "UnknownError", data: { message: "Unexpected server error (expected nested prompt object)" } }));
    }
    const msgId = body.id || `msg_${(messageIdSeq++).toString(16).padStart(12, "0")}`;
    PENDING.set(sid, { msgId, text: body.prompt.text });
    for (const w of eventWaiters.splice(0)) w.resolve();
    return res.end(JSON.stringify({
      data: { admittedSeq: 1, id: msgId, sessionID: sid, prompt: body.prompt, delivery: body.delivery ?? "steer", timeCreated: Date.now() },
    }));
  }

  // GET /api/event -> global SSE stream. Waits for a prompt, emits that
  // session's execution events, then closes.
  if (url.pathname === "/api/event" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    res.write(`data: ${JSON.stringify({ id: "srv", type: "server.connected", data: {} })}\n\n`);

    if (PENDING.size === 0) {
      await new Promise(resolve => {
        eventWaiters.push({ resolve });
        res.on("close", resolve);
      });
      if (res.writableEnded || PENDING.size === 0) return res.end();
    }

    for (const [sid, pending] of PENDING) {
      PENDING.delete(sid);
      const text = `Hello from mock, received: ${pending.text.slice(0, 40)}`;
      const events = [
        { id: pending.msgId, type: "session.next.step.started", data: { sessionID: sid, assistantMessageID: pending.msgId } },
        { id: pending.msgId, type: "session.next.text.started", data: { sessionID: sid, assistantMessageID: pending.msgId, textID: `txt_${pending.msgId}` } },
        { id: pending.msgId, type: "session.next.text.delta", data: { sessionID: sid, assistantMessageID: pending.msgId, textID: `txt_${pending.msgId}`, delta: text } },
        { id: pending.msgId, type: "session.next.text.ended", data: { sessionID: sid, assistantMessageID: pending.msgId, textID: `txt_${pending.msgId}`, text } },
        { id: pending.msgId, type: "session.next.step.ended", data: { sessionID: sid, assistantMessageID: pending.msgId, finish: "stop", tokens: stepTokens } },
      ];
      for (const e of events) {
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      }
    }
    return res.end();
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock opencode server on http://127.0.0.1:${PORT}`);
});
