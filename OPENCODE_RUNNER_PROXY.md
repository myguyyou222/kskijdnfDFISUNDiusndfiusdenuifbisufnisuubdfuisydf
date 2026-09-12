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

## V2 contract (verified against `opencode.ai/v2/openapi.json`)

- **`/api/session/{id}/prompt`** request body is `{ id, text, files, agents, skills?, metadata?, delivery?, resume? }` — `text` is a top-level string. There is **no** nested `prompt` object (`additionalProperties: false`).
- The prompt response is JSON `Session.Inbox.User` (`{ id, sessionID, timeCreated, type, payload, delivery }`), **not** SSE. It has no `admittedSeq` cursor.
- **`/api/event`** is the *single* global event route — no path params, no `after` cursor. It is filtered by the flat `directory` query param (or the `x-opencode-directory` header). The `location[directory]=...` shape is **rejected**.
- Events are SSE lines whose `data:` field is a JSON envelope: `{ id, type, properties }`. The field is **`properties`**, not `data`.
- Text deltas arrive as `session.next.text.delta` with `properties.delta` (not `properties.text`).
- Turn finish is `session.next.step.ended` with `properties.finish` and `properties.tokens` (`{ input, output, reasoning, cache }`).
- Turn completion is `session.idle` with `properties.sessionID`.
- Errors are `session.error` / `session.next.step.failed` with `properties.error.message`.
- **`/api/session/{id}/event` does not exist** — there is no per-session event route.
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