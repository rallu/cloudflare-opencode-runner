# cloudflare-opencode-runner

**Per-run OpenCode servers on Cloudflare Containers**, built for [Harness Router](https://harness-router.dugongi.com/) by [Dugongi](https://dugongi.com/).

When Harness Router delegates a Linear issue to OpenCode, this Worker spins up an **isolated container** for that run, clones the repo, exposes an OpenCode UI link, and destroys the instance on cancel, archive, merge, or after a max lifetime (default **4 hours**).

> Not affiliated with the separate open-source project at [`HarnessRouter/harnessrouter`](https://github.com/HarnessRouter/harnessrouter). This repo is the OpenCode runner for **Harness Router** by Dugongi.

## Features

- **One container per run** — Durable Object keyed by `runId`
- **UI link for humans** — `https://<worker>/r/<runId>/` (put behind Cloudflare Access)
- **Automation API** — `POST /api/runs` returns `openCodeUrl` for Linear comments
- **Low concurrency** — default `max_instances = 4`
- **Hard TTL** — DO alarm destroys the instance after 4 hours
- **No OpenCode basic auth** — use Cloudflare Access for browsers; Access service token + optional `RUNNER_API_TOKEN` for harness-router

## Architecture

```
Linear → Harness Router → POST /api/runs → Cloudflare Worker
                              ↓
                     Container (OpenCode serve)
                              ↓
              openCodeUrl → /r/:runId/  (Access-protected UI)
```

## Prerequisites

- Cloudflare account with **Workers Paid** (Containers)
- Node.js 22+
- Docker (local image build for deploy)
- [OpenCode Zen](https://opencode.ai/auth) API key (or configure another provider in `opencode.json`)
- Cloudflare Access on the Worker hostname (recommended)

## Quick start

```bash
npm install
npx wrangler secret put OPENCODE_API_KEY
npx wrangler secret put GIT_TOKEN          # optional, private repos
npx wrangler secret put RUNNER_API_TOKEN   # optional but recommended for /api/runs
npm run deploy
```

Enable **Cloudflare Access** on the `workers.dev` route (or custom domain) so the UI is not public.

## API (for Harness Router)

### Create a run

`POST /api/runs`

```http
Authorization: Bearer <RUNNER_API_TOKEN>
CF-Access-Client-Id: <access-client-id>
CF-Access-Client-Secret: <access-client-secret>
Content-Type: application/json

{
  "runId": "ENG-142",
  "repo": "https://github.com/org/repo.git",
  "branch": "main"
}
```

Response includes `openCodeUrl` / `url` pointing at `/r/<runId>/` — put that link in Linear.

### Status / destroy

- `GET /api/runs/:runId`
- `DELETE /api/runs/:runId` — call on Linear cancel/archive or after GitHub merge

### OpenCode session API

Drive OpenCode under `/r/:runId/` (see OpenCode `/doc`), e.g. `POST /r/:runId/session`, `POST /r/:runId/session/:id/message`, SSE `GET /r/:runId/event`.

## Configuration

| Setting | Where | Default |
|--------|--------|---------|
| `max_instances` | `wrangler.toml` | `4` |
| `MAX_RUN_LIFETIME_MS` | `wrangler.toml` `[vars]` | `14400000` (4h) |
| `OPENCODE_API_KEY` | secret | required |
| `GIT_TOKEN` | secret | optional |
| `RUNNER_API_TOKEN` | secret | optional (if unset, rely on Access alone) |

## Security notes

- Do **not** enable OpenCode `OPENCODE_SERVER_PASSWORD` for browser use — basic auth re-prompts on assets/SSE.
- Put Cloudflare Access in front of the Worker for humans.
- Use an Access **service token** for Harness Router → Worker calls.
- Never commit `.dev.vars` or local token files.

## License

MIT © Dugongi / Juha-Pekka Rajaniemi

## Related

- Product: [harness-router.dugongi.com](https://harness-router.dugongi.com/)
- [OpenCode](https://opencode.ai/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
