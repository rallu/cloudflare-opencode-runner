# cloudflare-opencode-runner

**Per-run OpenCode servers on Cloudflare Containers**, built for [Harness Router](https://harness-router.dugongi.com/) by [Dugongi](https://dugongi.com/).

When Harness Router delegates a Linear issue to OpenCode, this Worker spins up an **isolated container** for that run, clones the repo, and exposes an OpenCode UI link. Idle containers **sleep** after **2 hours** of no HTTP activity (not wall-clock from start); soft max lifetime (default **4 hours**) **stops** the container but keeps the run id so it can be started again. Disk is ephemeral — resume via git work branch `opencode/<runId>` (agent must push; wake restores from remote). **Destroy only** on explicit `DELETE /api/runs/:id` (harness cancel/archive/merge) or admin destroy — not on the default TTL alarm.

> Not affiliated with the separate open-source project at [`HarnessRouter/harnessrouter`](https://github.com/HarnessRouter/harnessrouter). This repo is the OpenCode runner for **Harness Router** by Dugongi.

## Features

- **One container per run** — Durable Object keyed by `runId`
- **UI link for humans** — `https://<worker>/r/<runId>/…/session/…` when auto-prompted (else `/r/<runId>/`; Access-protected)
- **Automation API** — `POST /api/runs` returns `openCodeUrl` for Linear comments
- **Low concurrency** — default `max_instances = 8` (see `wrangler.toml`)
- **Idle sleep** — `sleepAfter = 2h` (HTTP activity timeout; container stops; DO / run id retained; `POST …/start` wakes it)
- **Git-as-volume resume** — deterministic `workBranch` `opencode/<runId>`; agent pushes after changes; wake checks out that remote branch (chat history still lost on sleep)
- **Soft lifetime** — `maxLifetimeMs` / `MAX_RUN_LIFETIME_MS` (default 4h) stops the run on alarm; set `hardDestroyOnExpiry: true` only if you want TTL to destroy
- **Destroy** — `DELETE /api/runs/:id` (or admin destroy); harness must DELETE on merge/cancel
- **Curated Ubuntu coding image** — `ubuntu:24.04` (linux/amd64) with Node, Python/uv, Go, Rust, Java 21, gh, ripgrep, and more (see below)
- **No OpenCode basic auth** — use Cloudflare Access for browsers; Access service token + optional `RUNNER_API_TOKEN` for harness-router

## Architecture

```
Linear → Harness Router → POST /api/runs → Cloudflare Worker
                              ↓
                     Container (OpenCode serve)
                              ↓
              openCodeUrl → /r/:runId/…/session/…  (Access-protected UI; deep link when prompted)
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

### Connection health (no container)

`GET /api/health` — authenticated control-plane check. Reports whether a capabilities snapshot exists.

`GET /worker-health` — unauthenticated Worker liveness (for probes that cannot send Access headers).

### Capabilities / model discovery (no container)

`GET /api/capabilities` — last OpenCode providers, models, agents, and commands captured from a live instance.

On every successful `POST /api/runs` bootstrap the runner queries OpenCode (`/global/health`, `/config`, `/config/providers`, `/provider`, `/agent`, `/command`), stores a normalized snapshot in a Durable Object, and returns it on the create response as `capabilities`. Harness Router should use this cache for template pickers; it does **not** start a container.

Until the first successful run, `available` is `false`.

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
  "branch": "main",
  "setup": ["npm install"],
  "prompt": "Fix the failing test and open a PR.",
  "title": "ENG-142",
  "model": { "providerID": "opencode", "modelID": "big-pickle" },
  "agent": "build",
  "autoPR": true
}
```

Optional fields:
- **`setup`** — shell commands in the first cloned repo after clone, before OpenCode starts. A failing command fails startup (surfaces in bootstrap error / crash log).
- **`prompt`** — after the container is ready, auto-create a session and `prompt_async`. Default model is `opencode` / `big-pickle` when omitted. Response includes `sessionId`, `promptAccepted`, and `prompt: { ok, sessionId, error? }`. Session failures do not mark the run as failed (`success: true` if the container is ready).
- **`agent`** — OpenCode agent name (e.g. `build`, `plan`). Passed into session create and `prompt_async`.
- **`autoPR`** / **`autoCreatePR`** — when `true` and agent is not `plan`, appends draft-PR instructions (`gh pr create --draft` from the same `workBranch`) to the prompt. Plan mode skips this (`autoPRApplied: false`, `autoPRSkippedReason: "plan-mode"`). Response echoes `autoPR`, `autoPRApplied`, `workBranch`, and `sleepAfter`.
- **Work branch** — every run with a prompt (non-plan) gets a standing instruction to commit + `git push -u origin opencode/<runId>` after code changes so wake can restore the tree.

Response includes `openCodeUrl` / `url` — when a prompt auto-starts a session this is a **session deep link** (`/r/<runId>/<cn(dir)>/session/<sessionId>`); otherwise `/r/<runId>/`. Opening either shows the chat (document entry 302s to the session when meta has `sessionId`+`directory`). Put that link in Linear.

### Status / lifecycle

- `GET /api/runs/:runId`
- `POST /api/runs/:runId/start` — wake a stopped/slept run
- `POST /api/runs/:runId/stop` — sleep/stop (keep run id)
- `DELETE /api/runs/:runId` — **only** hard destroy; call on Linear cancel/archive or after GitHub merge
- Idle inactivity uses `sleepAfter=2h` (HTTP requests reset the timer). Soft `maxLifetimeMs` stops the container; it does **not** destroy unless `hardDestroyOnExpiry: true`. On wake, `startup.sh` restores `WORK_BRANCH` from origin when present.

### OpenCode session API

Drive OpenCode under `/r/:runId/` (see OpenCode `/doc`), e.g. `POST /r/:runId/session`, `POST /r/:runId/session/:id/prompt_async`, SSE `GET /r/:runId/event`. With sticky `oc_run` cookie (after opening the UI once), root `/session/...` also proxies to the run.


## Container image (coding base)

`Dockerfile` is based on **`ubuntu:24.04`** (`linux/amd64`), not Alpine and not `cloudflare/sandbox` (wrong ENTRYPOINT).

**apt:** bash, zsh, git, git-lfs, curl, wget, jq, unzip/zip/tar, openssh-client, ca-certificates, build-essential, pkg-config, make, cmake, sqlite3, ripgrep, fd (`fdfind` → `fd`), fzf, tini

**Toolchains** (pinned in `mise.toml`, installed with [mise](https://mise.jdx.dev/) into `/opt/mise`):

| Tool | Pin (see `mise.toml`) |
|------|------------------------|
| Node (LTS) + corepack (pnpm/yarn) | 24.x |
| Bun | pinned |
| Python 3 + pip + uv | 3.12 + uv |
| Go | 1.24.x |
| Rust / cargo | 1.89.0 via rustup in `/opt/rust` (not mise) |
| Java (Temurin) + Maven + Gradle | 21 + Maven/Gradle |
| GitHub CLI `gh` | pinned |
| `opencode-ai` | pinned in Dockerfile `ARG OPENCODE_VERSION` |

Non-root user `dev`, `EXPOSE 4096`, `ENTRYPOINT ["/bin/bash", "/home/dev/startup.sh"]` (unchanged). Aim ≤2GB compressed / ≤5GB unpacked; Cloudflare **standard-2** has 12GB disk — leave headroom for clones. If the image build exceeds size/time limits, drop Java/Gradle first.

Always build with `--platform=linux/amd64` (Wrangler/Containers does this for the configured Dockerfile).

## Configuration

| Setting | Where | Default |
|--------|--------|---------|
| `max_instances` | `wrangler.toml` | `8` |
| `instance_type` | `wrangler.toml` | `standard-2` (12GB disk) |
| `sleepAfter` | `OpenCodeRunner` in `src/index.ts` | `2h` (idle HTTP → sleep) |
| `MAX_RUN_LIFETIME_MS` | `wrangler.toml` `[vars]` | `14400000` (4h **soft** stop) |
| `hardDestroyOnExpiry` | `POST /api/runs` body | `false` (TTL does not destroy) |
| `OPENCODE_API_KEY` | secret | required |
| `GIT_TOKEN` | secret | optional |
| `RUNNER_API_TOKEN` | secret | optional (if unset, rely on Access alone) |

## Browser admin vs automation API

| Surface | Auth | Purpose |
|--------|------|---------|
| `GET /admin`, `/admin/api/*` | Cloudflare Access (browser / Access service token) | Human admin UI — list/create/start/stop/destroy. **No** `RUNNER_API_TOKEN`. |
| `/api/runs*`, `/api/capabilities`, `/api/health` | Access + optional `Authorization: Bearer $RUNNER_API_TOKEN` | Harness Router automation |

Do not call `/api/runs` from the browser admin — it returns 401 without the runner bearer.

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
