# OpenCode Cloudflare runner ↔ Dugongi Harness Router

**Decision (2026-09-16):** Keep Rubikc CF OpenCode runner for Linear UI links. Do not use harnessrouter.ai for this UX (no shareable OpenCode UI).

## Backend (already live)

- Base: `https://opencode-server.rubikc.workers.dev`
- Mode: one Cloudflare Container per run (`max_instances=4`, ~4h lifetime)
- Front door: Cloudflare Access (human browser login for UI)
- Automation API: `/api/runs*` (optional `Authorization: Bearer $RUNNER_API_TOKEN` if secret set)

### Create run

`POST /api/runs`

Headers:
- `Content-Type: application/json`
- `Authorization: Bearer <RUNNER_API_TOKEN>` (required if token configured on Worker)
- Cloudflare Access service token headers (required for server-to-server past Access):
  - `CF-Access-Client-Id: <client_id>`
  - `CF-Access-Client-Secret: <client_secret>`

Body (all optional):
```json
{
  "runId": "linear-ENG-142-abc",
  "repo": "owner/name",
  "branch": "main",
  "maxLifetimeMs": 14400000
}
```

Response `201`:
```json
{
  "runId": "...",
  "url": "https://opencode-server.rubikc.workers.dev/r/<runId>/",
  "openCodeUrl": "https://opencode-server.rubikc.workers.dev/r/<runId>/",
  "links": {
    "ui": "https://opencode-server.rubikc.workers.dev/r/<runId>/",
    "health": "https://opencode-server.rubikc.workers.dev/r/<runId>/global/health",
    "openapi": "https://opencode-server.rubikc.workers.dev/r/<runId>/doc"
  }
}
```

### Status / destroy

- `GET /api/runs/:runId` → status + `openCodeUrl`
- `DELETE /api/runs/:runId` → destroy container

### Human UI

- Share `openCodeUrl` in Linear. Humans open it; Cloudflare Access prompts login (e.g. juha-pekka.rajaniemi@rubikc.com policy).
- Service token is for harness-router API calls only; do not put secrets in Linear.

## What harness-router.dugongi.com should implement

Mirror Cursor harness templates:

1. **Harness type:** `opencode` (alongside existing `cursor`).
2. **Template fields:** account/credentials not Cursor; instead store OpenCode runner base URL + Access service token refs + optional default `repo`/`branch` + instructions/prompt seed.
3. **On Linear delegate** (router- label / mention):
   - `POST /api/runs` with stable `runId` derived from Linear issue id + attempt (idempotent reuse).
   - Pass GitHub `repo`/`branch` from template when known.
   - Comment on Linear with `openCodeUrl` (primary UX).
   - Optionally POST initial prompt into OpenCode session API under that run URL if product wants auto-start (OpenAPI at `links.openapi`); otherwise leave human/agent to drive the UI.
4. **On cancel / archive / merge / failure:** `DELETE /api/runs/:runId`.
5. **Secrets (Doppler/env):** `OPENCODE_BASE_URL`, `OPENCODE_RUNNER_API_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.

## Cloudflare Access setup (dashboard — API token lacked Access create)

1. Zero Trust → Access → Applications → app covering `opencode-server.rubikc.workers.dev`.
2. Create **Service Token** for harness-router.
3. Add Access policy allowing that service token for `/api/*` (and optionally keep email policy for UI paths `/r/*`).
4. Prefer splitting policies: service token for `/api/*`; browser email for `/r/*` and `/admin`.

## Out of scope

- Publishing `rallu/harness-router-opencode` (paused).
- harnessrouter.ai OpenCode backend for Linear UI links.

## Capabilities discovery (no warm instance)

1. On each successful `POST /api/runs`, the runner scrapes OpenCode and stores a snapshot.
2. Harness Router reads `GET /api/capabilities` (same auth as runs) for template model/agent pickers.
3. Connection Ready: `GET /api/health` (or `/worker-health` + Access) — do not poll `POST /api/runs`.
4. First deploy: capabilities stay empty until the first successful run (or admin refresh).
