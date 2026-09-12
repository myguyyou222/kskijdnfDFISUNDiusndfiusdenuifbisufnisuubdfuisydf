# OpenCode Runner Proxy

Local proxy that exposes an **OpenAI-compatible API** (`/v1/chat/completions`,
`/v1/completions`, `/v1/models`) backed by an **OpenCode** server running on an
ephemeral GitHub Actions runner, discovered over Tailscale.

No Oracle intermediary. Cline (or any OpenAI client) talks to the proxy; the
proxy translates to OpenCode's V2 HTTP API.

## Files

| File | Purpose |
| --- | --- |
| `scripts/opencode-proxy.mjs` | Local proxy (Node 20+, ESM, zero deps) |
| `.github/workflows/opencode-runner.yml` | GitHub Actions runner workflow |
| `test/mock-opencode-server.mjs` | Mock OpenCode V2 server (contract fixture) |
| `test/opencode-proxy.test.mjs` | End-to-end test harness (`npm run test:opencode`) |

## Run

```sh
cp .env.example .env   # fill in OPENCODE_URL or Tailscale creds
npm run test:opencode  # validates the proxy against the mock OpenCode server
node scripts/opencode-proxy.mjs
```

## Proxy endpoints

| Proxy | OpenCode V2 |
| --- | --- |
| `GET /health` | `GET /api/health` |
| `GET /v1/models` | `GET /api/model?directory=...` |
| `POST /v1/chat/completions` | `POST /api/session` → `POST /api/session/{id}/prompt` → `GET /api/event` |
| `POST /v1/completions` | same (legacy text-completions response shape) |

## V2 contract (verified against a LIVE opencode-ai@1.18.30 server, 2026-09)

- **`/api/session/{id}/prompt`** request body REQUIRES a nested `prompt` object:
  `{ id?, prompt: { text, files?, agents? }, delivery?, resume? }` (`additionalProperties: false`).
  A top-level `text` is rejected with HTTP 500 ("Unexpected server error").
- The prompt response is an admission receipt: `{ data: { admittedSeq, id, sessionID, prompt, delivery, timeCreated } }`, **not** SSE.
- **`/api/event`** is the *single* global event route — no path params, no `after` cursor.
- Event envelopes are SSE `data:` lines shaped `{ id, type, data }` — the payload field is **`data`** (there is no `properties` key on this build).
- Text deltas arrive as `session.next.text.delta` with `data.delta`.
- Turn step finish is `session.next.step.ended` with `data.finish` and `data.tokens` (`{ input, output, reasoning, cache }`).
- **There is no `session.idle` event** and `POST /api/session/{id}/wait` 503s forever on this build — the proxy detects turn completion as `step.ended` followed by a 2s quiet gap (multi-step turns emit a new `session.next.step.started` inside that window).
- Errors surface as an assistant message with `finish: "error"` and `error.message` (plus `session.error` events).
- **Do not pin `location.directory` to a client-side path when creating sessions** — the server 500s prompts for directories that don't exist on the server. Omit `location` to use the server's workdir.
- The live spec is served at `GET /doc` (OpenAPI 3.1 JSON; `/openapi.json` returns an HTML shell).
- **`Model.Info` has no `status`/`enabled` fields** — pick the first available model by `id`.

## Environment

See `.env.example`. `OPENCODE_URL` (direct server) or Tailscale discovery
(`TAILSCALE_TAILNET`, `TAILSCALE_API_KEY`) selects the runner. `OPENCODE_WORKSPACE`
defaults to `process.cwd()`.

## Tests

```sh
npm run test:opencode
```

Starts the mock server + proxy and exercises `/health`, `/v1/models`,
non-streaming + streaming `/v1/chat/completions`, and `/v1/completions`.