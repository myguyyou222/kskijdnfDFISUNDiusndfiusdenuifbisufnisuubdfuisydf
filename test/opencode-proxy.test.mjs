import http from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PROXY_PORT = 4097;
const MOCK_PORT = 4096;

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } },
      res => {
        let buf = "";
        res.on("data", c => buf += c);
        res.on("end", () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path, headers }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on("error", reject);
  });
}

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

async function main() {
  // 1. Start mock OpenCode server
  const mock = spawn(process.execPath, ["test/mock-opencode-server.mjs"], { stdio: "pipe" });
  mock.stdout.on("data", d => console.log(`[mock] ${d.toString().trim()}`));
  mock.stderr.on("data", d => console.error(`[mock-err] ${d.toString().trim()}`));
  await sleep(500);

  // 2. Start the proxy pointed at the mock
  const env = {
    ...process.env,
    OPENCODE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    OPENCODE_RUNNER_PORT: String(MOCK_PORT),
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: "test-password",
    OPENCODE_WORKSPACE: "/mock-workspace",
    OPENCODE_PROXY_PORT: String(PROXY_PORT),
    OPENCODE_PROXY_HOST: "127.0.0.1",
  };
  const proxy = spawn(process.execPath, ["scripts/opencode-proxy.mjs"], { env, stdio: "pipe" });
  proxy.stdout.on("data", d => console.log(`[proxy] ${d.toString().trim()}`));
  proxy.stderr.on("data", d => console.error(`[proxy-err] ${d.toString().trim()}`));
  await sleep(800);

  try {
    // /health
    const health = await get(PROXY_PORT, "/health");
    check("GET /health returns 200", health.status === 200, `status=${health.status} body=${health.body}`);
    check("GET /health reports healthy", health.body.includes('"healthy":true'), health.body);

    // /v1/models
    const models = await get(PROXY_PORT, "/v1/models");
    check("GET /v1/models returns 200", models.status === 200, `status=${models.status}`);
    const parsed = JSON.parse(models.body);
    check("GET /v1/models is OpenAI list shape", parsed.object === "list" && Array.isArray(parsed.data), models.body);
    check("GET /v1/models maps model ids", parsed.data.some(m => m.id === "anthropic/claude-sonnet-4-5"), models.body);

    // Non-streaming chat completion
    const chat = await post(PROXY_PORT, "/v1/chat/completions", {
      model: "anthropic/claude-sonnet-4-5",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    });
    check("POST /v1/chat/completions returns 200", chat.status === 200, `status=${chat.status} body=${chat.body}`);
    const chatBody = JSON.parse(chat.body);
    check("Chat completion is OpenAI shape", chatBody.object === "chat.completion", chat.body);
    check("Chat completion has assistant content", chatBody.choices?.[0]?.message?.content?.includes("Hello from mock"), chat.body);
    check("Chat completion has usage", chatBody.usage?.completion_tokens === 34, chat.body);

    // Streaming chat completion
    const sse = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: PROXY_PORT, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json" } }, res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject);
      req.write(JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "Hi" }], stream: true }));
      req.end();
    });
    check("Streaming chat returns 200", sse.status === 200, `status=${sse.status}`);
    check("Streaming emits SSE chunks", sse.body.includes("chat.completion.chunk"), sse.body);
    check("Streaming forwards real delta text", sse.body.includes("Hello from mock, received:"), sse.body);
    check("Streaming ends with [DONE]", sse.body.includes("[DONE]"), sse.body);

    // Legacy /v1/completions
    const comp = await post(PROXY_PORT, "/v1/completions", { model: "openai/gpt-4o", prompt: "Yo", stream: false });
    check("POST /v1/completions returns 200", comp.status === 200, `status=${comp.status} body=${comp.body}`);
    const compBody = JSON.parse(comp.body);
    check("Completions is text_completion shape", compBody.object === "text_completion", comp.body);
    check("Completions has text", compBody.choices?.[0]?.text?.includes("Hello from mock"), comp.body);

    // Read-only tool_calls mirror: prompt containing "tool" triggers the mock's
    // native tool round-trip. With Option B, the proxy holds on finish=tool-calls
    // and DOES NOT append results or aggregate later steps.
    const toolChat = await post(PROXY_PORT, "/v1/chat/completions", {
      model: "anthropic/claude-sonnet-4-5",
      messages: [{ role: "user", content: "Please use a tool to echo hi" }],
      stream: false,
    });
    check("Tool chat returns 200", toolChat.status === 200, `status=${toolChat.status} body=${toolChat.body}`);
    const toolBody = JSON.parse(toolChat.body);
    check("Tool chat finish_reason is tool_calls", toolBody.choices?.[0]?.finish_reason === "tool_calls", toolChat.body);
    check("Tool chat mirrors native call", toolBody.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === "bash", toolChat.body);
    check("Tool chat call has input args", toolBody.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments?.includes("mock-tool-ok"), toolChat.body);
    check("Tool chat usage input", toolBody.usage?.prompt_tokens !== undefined, JSON.stringify(toolBody.usage));

    // Test the follow-up request to verify session affinity (Option B)
    const followUpCallId = toolBody.choices?.[0]?.message?.tool_calls?.[0]?.id;
    if (followUpCallId) {
      const followUpChat = await post(PROXY_PORT, "/v1/chat/completions", {
        model: "anthropic/claude-sonnet-4-5",
        messages: [
          { role: "user", content: "Please use a tool to echo hi" },
          { role: "assistant", tool_calls: toolBody.choices?.[0]?.message?.tool_calls },
          { role: "tool", tool_call_id: followUpCallId, content: "mock-tool-ok\n" }
        ],
        stream: false,
      });
      check("Tool follow-up returns 200", followUpChat.status === 200, `status=${followUpChat.status} body=${followUpChat.body}`);
      const followUpBody = JSON.parse(followUpChat.body);
      check("Tool follow-up responds correctly", followUpBody.choices?.[0]?.message?.content?.includes("Hello from mock"), followUpChat.body);
    } else {
      check("Tool follow-up returns 200", false, "No tool_call_id found in previous step");
    }

    // Streaming tool mirror: one tool_calls chunk + finish_reason=tool_calls.
    const toolSse = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: PROXY_PORT, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json" } }, res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject);
      req.write(JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "Run a tool please" }], stream: true }));
      req.end();
    });
    check("Streaming tool chat returns 200", toolSse.status === 200, `status=${toolSse.status}`);
    check("Streaming tool chat emits tool_calls chunk", toolSse.body.includes('"tool_calls"'), toolSse.body);
    check("Streaming tool chat finish is tool_calls", toolSse.body.includes('"finish_reason":"tool_calls"'), toolSse.body);
  } finally {
    proxy.kill();
    mock.kill();
  }

  console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error("Harness error:", e); process.exit(1); });
