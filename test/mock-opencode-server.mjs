import http from "node:http";

// Mock OpenCode V2 server implementing ONLY the routes the proxy calls:
//   GET  /api/health
//   GET  /api/model?directory=...
//   POST /api/session
//   POST /api/session/{id}/prompt   -> JSON (Session.Inbox.User)
//   GET  /api/event?directory=...    -> SSE event stream
//
// Shapes mirror the official OpenCode V2 contract (opencode.ai/v2/openapi.json
// and packages/sdk/js/src/v2/gen/types.gen.ts).

const PORT = 4096;
const USERNAME = "opencode";
const PASSWORD = "test-password";
const WORKSPACE = "/mock-workspace";
const stepTokens = { input: 12, output: 34 };

const SESSIONS = new Map();          // sessionID -> { id, agent, directory }
const PENDING = new Map();           // directory -> { msgId, sid, text }
let messageIdSeq = 0;
let sessionIdSeq = 0;
const eventWaiters = new Map();      // directory -> [{ resolve, reject }]

function basicAuth(req) {
  const h = req.headers.authorization || "";
  const expected = "Basic " + Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64");
  return h === expected;
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
  const dir = url.searchParams.get("directory");

  if (!basicAuth(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  // GET /api/health
  if (url.pathname === "/api/health" && req.method === "GET") {
    return res.end(JSON.stringify({ healthy: true }));
  }

  // GET /api/model?directory=...
  if (url.pathname === "/api/model" && req.method === "GET") {
    return res.end(JSON.stringify({
      location: { directory: dir || WORKSPACE },
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
    const session = { id, title: body.title || "mock", agent: body.agent || "default", directory: dir || WORKSPACE };
    SESSIONS.set(id, session);
    return res.end(JSON.stringify({ data: session }));
  }

  // POST /api/session/{id}/prompt -> JSON (Session.Inbox.User), NOT SSE.
  const promptMatch = url.pathname.match(/^\/api\/session\/(ses_[0-9a-f]+)\/prompt$/);
  if (promptMatch && req.method === "POST") {
    const sid = promptMatch[1];
    const body = await readBody(req);
    if (!SESSIONS.has(sid)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Session not found" }));
    }
    // Validate the corrected body shape: top-level `text`, no nested `prompt`.
    if (typeof body.text !== "string" || body.prompt) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid prompt body: expected top-level text" }));
    }
    const msgId = `msg_${(messageIdSeq++).toString(16).padStart(12, "0")}`;
    const session = SESSIONS.get(sid);
    const sessionDir = session ? session.directory : (dir || WORKSPACE);
    PENDING.set(sessionDir, { msgId, sid, text: body.text });
    // Wake any open /api/event stream waiting on this directory.
    for (const w of eventWaiters.get(sessionDir) || []) w.resolve();
    eventWaiters.delete(sessionDir);
    return res.end(JSON.stringify({
      data: { id: msgId, sessionID: sid, timeCreated: Date.now(), type: "user", payload: {}, delivery: "steer" },
    }));
  }

  // GET /api/event?directory=... -> SSE. Stays open until a prompt is posted
  // for this directory, then emits that session's execution events and closes.
  if (url.pathname === "/api/event" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: message\ndata: ${JSON.stringify({ id: "srv", type: "server.connected", properties: {} })}\n\n`);

    if (PENDING.has(dir)) {
      return emitSessionEvents(res, dir);
    }

    return new Promise(resolve => {
      const waiter = { resolve, reject: () => {} };
      const list = eventWaiters.get(dir) || [];
      list.push(waiter);
      eventWaiters.set(dir, list);
      res.on("close", () => { waiter.reject(); });
    }).then(() => emitSessionEvents(res, dir), () => res.end());
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

function emitSessionEvents(res, dir) {
  const pending = PENDING.get(dir);
  if (!pending) return res.end();
  const text = `Hello from mock, received: ${pending.text.slice(0, 40)}`;
  const events = [
    { id: pending.msgId, type: "session.next.text.started", properties: { sessionID: pending.sid, assistantMessageID: pending.msgId, textID: `txt_${pending.msgId}` } },
    { id: pending.msgId, type: "session.next.text.delta", properties: { sessionID: pending.sid, assistantMessageID: pending.msgId, textID: `txt_${pending.msgId}`, delta: text } },
    { id: pending.msgId, type: "session.next.text.ended", properties: { sessionID: pending.sid, assistantMessageID: pending.msgId, textID: `txt_${pending.msgId}`, text } },
    { id: pending.msgId, type: "session.next.step.ended", properties: { sessionID: pending.sid, assistantMessageID: pending.msgId, finish: "stop", tokens: stepTokens } },
    { id: pending.msgId, type: "session.idle", properties: { sessionID: pending.sid } },
  ];
  // Headers already sent by the caller; write SSE lines directly.
  for (const e of events) {
    res.write(`event: message\n`);
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  }
  PENDING.delete(dir);
  res.end();
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock opencode server on http://127.0.0.1:${PORT}`);
});