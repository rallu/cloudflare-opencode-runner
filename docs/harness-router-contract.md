# OpenCode Cloudflare runner ↔ Dugongi Harness Router

**Decision (2026-09-16):** Keep the Cloudflare OpenCode runner for Linear UI links. Do not use harnessrouter.ai for this UX (no shareable OpenCode UI).

## Backend (already live)

- Base: `https://opencode-runner.<your-subdomain>.workers.dev`
- Mode: one Cloudflare Container per run (`max_instances=8`, idle sleep **2h** (HTTP activity, not wall-clock from start), soft ~4h stop; destroy via DELETE)
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
  "repo": "https://github.com/org/repo.git",
  "branch": "main",
  "maxLifetimeMs": 14400000,
  "hardDestroyOnExpiry": false,
  "setup": ["npm install"],
  "prompt": "Implement the issue…",
  "title": "ENG-142",
  "model": { "providerID": "opencode", "modelID": "big-pickle" },
  "agent": "build",
  "autoPR": true,
  "gitToken": "<github-app-installation-token>"
}
```

- `setup`: shell commands run in the first cloned repo **after clone, before** `opencode serve`. Failure fails container startup (bootstrap error).
- `prompt`: if set, after OpenCode is ready the runner creates a session and calls `prompt_async` (default model `opencode` / `big-pickle`).
- `autoPR` / `autoCreatePR`: optional boolean (default false). When true and `agent` is **not** `"plan"`, the runner appends draft-PR instructions (`gh pr create --draft` from the **same** work branch after the task). Cursor alias `autoCreatePR` is accepted the same way. In plan mode (`agent: "plan"`), autoPR is **skipped** (`autoPRApplied: false`, `autoPRSkippedReason: "plan-mode"`).
- `gitToken` / `ghToken`: optional ephemeral GitHub token for this run (App installation token preferred). Preferred over Worker `GIT_TOKEN`. Injected as `GIT_TOKEN` + `GH_TOKEN`. Never returned from GET. Refresh via `POST /api/runs/:runId/git-token` (then start/restart) for runs past the ~1h installation-token TTL. Do not send the App private key.
- `maxLifetimeMs`: soft lifetime — on expiry the runner **stops/sleeps** (keeps run id / DO). Does **not** destroy by default.
- `hardDestroyOnExpiry`: optional; if `true`, TTL alarm calls destroy. Prefer leaving false and `DELETE` on merge.
- Idle: container `sleepAfter=2h` (resets on **HTTP requests** to the container, not CPU/wall-clock from start).
- **Git-as-volume resume:** each run gets a deterministic `workBranch` = `opencode/<runId>`. On every start/wake, `startup.sh` restores from `origin/$WORK_BRANCH` if it exists; otherwise checks out the base `branch`/`main` and creates the work branch locally. Agent must `git push -u origin <workBranch>` after code changes (standing prompt instruction; not required in plan mode). Disk remains ephemeral; chat history is still lost on sleep.
- Port-ready wait is 300s so slow `npm install` can finish before serve starts.

Response `201`:
```json
{
  "runId": "...",
  "sleepAfter": "2h",
  "workBranch": "opencode/<runId>",
  "url": "https://opencode-runner.<your-subdomain>.workers.dev/r/<runId>/<cn(dir)>/session/<sessionId>",
  "openCodeUrl": "https://opencode-runner.<your-subdomain>.workers.dev/r/<runId>/<cn(dir)>/session/<sessionId>",
  "sessionId": "ses_…",
  "promptAccepted": true,
  "autoPR": true,
  "autoPRApplied": true,
  "prompt": { "ok": true, "sessionId": "ses_…", "promptAccepted": true, "directory": "/home/dev/repo" },
  "links": {
    "ui": "https://opencode-runner.<your-subdomain>.workers.dev/r/<runId>/<cn(dir)>/session/<sessionId>",
    "health": "https://opencode-runner.<your-subdomain>.workers.dev/r/<runId>/global/health",
    "openapi": "https://opencode-runner.<your-subdomain>.workers.dev/r/<runId>/doc"
  }
}
```

When a `repo` is provided, bootstrap always creates a session in the cloned worktree (even without `prompt`) and returns `openCodeUrl` / `url` / `links.ui` as a **session deep link** `/r/<runId>/<cn(dir)>/session/<sessionId>` (or `/r/<runId>/<cn(dir)>/session` if session creation failed). Bare `/r/<runId>/` 302s to that deep link so the UI opens the worktree project — not `$HOME` (`.cache`/`.config`/`.local`/`.npm`). Clone failure returns 500 with `crashLog` / an explicit error (set `GIT_TOKEN` for private repos).

Container ready still returns `success: true` even if session/prompt fails; check `prompt.ok` / `prompt.error`.

### Status / lifecycle

- `GET /api/runs/:runId` → status + `openCodeUrl` (never includes `gitToken`)
- `POST /api/runs/:runId/start` → wake stopped/slept run (optional `{ "gitToken" }` to refresh before wake)
- `POST /api/runs/:runId/git-token` → store fresh ephemeral token for next start/wake
- `POST /api/runs/:runId/stop` → sleep/stop (retain run id)
- `DELETE /api/runs/:runId` → **destroy** container (required on cancel/archive/merge)

### Human UI

- Share `openCodeUrl` in Linear. Humans open it; Cloudflare Access prompts login (configure an email allowlist for your team).
- Service token is for harness-router API calls only; do not put secrets in Linear.

## What harness-router.dugongi.com should implement

Mirror Cursor harness templates:

1. **Harness type:** `opencode` (alongside existing `cursor`).
2. **Template fields:** account/credentials not Cursor; instead store OpenCode runner base URL + Access service token refs + optional default `repo`/`branch` + instructions/prompt seed.
3. **On Linear delegate** (router- label / mention):
   - `POST /api/runs` with stable `runId` derived from Linear issue id + attempt (idempotent reuse).
   - Pass GitHub `repo`/`branch` from template when known.
   - Comment on Linear with `openCodeUrl` (primary UX).
   - Prefer passing `prompt` (+ optional `setup`, `model`, `title`) on `POST /api/runs` so the runner auto-creates a session and starts the agent; otherwise leave human/agent to drive the UI (OpenAPI at `links.openapi`).
4. **On cancel / archive / merge / failure:** `DELETE /api/runs/:runId` (required — TTL no longer auto-destroys by default).
5. **Secrets (Doppler/env):** `OPENCODE_BASE_URL`, `OPENCODE_RUNNER_API_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.

## GitHub App tokens (recommended)

Harness Router should mint a **repository-scoped GitHub App installation token** and pass it as `gitToken` on `POST /api/runs`. Do not put a long-lived PAT or the App private key into the runner.

1. Store App installation id in the GitHub integration (not a token).
2. Mint installation token with Contents + Pull requests read/write for the target repo.
3. Pass as `gitToken` (alias `ghToken`). Runner injects `GIT_TOKEN` + `GH_TOKEN`.
4. Tokens expire ~1 hour: before wake or mid-run git ops past expiry, mint again and `POST /api/runs/:runId/git-token` then `POST .../start` (or pass `gitToken` on start). A live container’s env is not hot-reloaded.
5. Worker `GIT_TOKEN` remains an optional admin/fallback secret only.


## Cloudflare Access setup (dashboard — API token lacked Access create)

1. Zero Trust → Access → Applications → app covering `opencode-runner.<your-subdomain>.workers.dev`.
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


## Browser admin (humans)

- UI: `GET /admin` (Access email policy)
- Control: `GET /admin/api/list`, `POST /admin/api/create`, `POST /admin/api/{start|stop|restart|destroy}?runId=`
- Does **not** use `RUNNER_API_TOKEN`. Automation remains on `/api/runs*` with bearer.
