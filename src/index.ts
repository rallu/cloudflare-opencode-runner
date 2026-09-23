import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getAdminHTML } from "./admin-ui";

interface Env {
  OPENCODE_CONTAINER: DurableObjectNamespace<OpenCodeRunner>;
  CAPABILITIES: DurableObjectNamespace<CapabilitiesCache>;
  RUNS_REGISTRY: DurableObjectNamespace<RunsRegistry>;
  OPENCODE_API_KEY: string;
  GIT_REPOS: string;
  GIT_TOKEN?: string;
  /** Optional bearer token for /api/runs (in addition to Cloudflare Access) */
  RUNNER_API_TOKEN?: string;
  /** Soft max lifetime before stop/sleep (ms). Default 4h. Destroy only via DELETE unless hardDestroyOnExpiry. */
  MAX_RUN_LIFETIME_MS?: string;
}

type RunMeta = {
  runId: string;
  repo?: string;
  /** Base / starting branch from the create request (RUN_BRANCH). */
  branch?: string;
  /** Deterministic per-run work branch the agent must push (WORK_BRANCH). */
  workBranch?: string;
  /** Post-clone shell commands (first repo). Also passed as SETUP_COMMANDS env. */
  setup?: string[];
  createdAt: number;
  /** Soft lifetime: on alarm, stop/sleep by default (not destroy). */
  expiresAt: number;
  /**
   * If true, TTL alarm calls destroy() instead of stop().
   * Default false — harness must DELETE /api/runs/:id on merge/cancel.
   */
  hardDestroyOnExpiry?: boolean;
  status: "starting" | "ready" | "error" | "stopped" | "destroyed";
  error?: string;
  /** Auto-prompt session created after bootstrap (if prompt was requested). */
  sessionId?: string;
  /** Working directory used for the auto-prompt session (for UI deep links). */
  directory?: string;
  /** Whether autoPR was requested at bootstrap (optional meta). */
  autoPR?: boolean;
  /**
   * Ephemeral GitHub token for this run (App installation token preferred).
   * Prefer over Worker GIT_TOKEN. Never expose in API JSON responses.
   */
  gitToken?: string;
};

/** Cached OpenCode discovery for harness-router (no live instance required). */
export type RunnerCapabilities = {
  available: boolean;
  updatedAt: string | null;
  sourceRunId: string | null;
  version: string | null;
  defaultModel: string | null;
  connectedProviders: string[];
  providers: unknown[];
  /** Flattened model ids like provider/model when available */
  models: Array<{ id: string; providerID?: string; name?: string }>;
  agents: unknown[];
  commands: unknown[];
  raw?: {
    health?: unknown;
    config?: unknown;
    configProviders?: unknown;
    provider?: unknown;
  };
  error?: string;
};

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const START_WAIT = {
  // Setup (e.g. npm install) runs before opencode serve; allow slow clones/installs.
  portReadyTimeoutMS: 300_000,
  instanceGetTimeoutMS: 60_000,
} as const;

const DEFAULT_PROMPT_MODEL = {
  providerID: "opencode",
  modelID: "big-pickle",
} as const;

const CONTAINER_START = {
  entrypoint: ["/bin/bash", "/home/dev/startup.sh"],
} as const;

const CAPABILITIES_KEY = "capabilities";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sanitizeRunId(runId: string): string | null {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(runId)) return null;
  return runId;
}

/** Deterministic work branch: opencode/<sanitized-runId> (safe chars only). */
export function workBranchName(runId: string): string {
  const safe =
    runId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "run";
  return `opencode/${safe}`;
}

function emptyCapabilities(error?: string): RunnerCapabilities {
  return {
    available: false,
    updatedAt: null,
    sourceRunId: null,
    version: null,
    defaultModel: null,
    connectedProviders: [],
    providers: [],
    models: [],
    agents: [],
    commands: [],
    error,
  };
}

/** Keep DO/cache payloads small — OpenCode /provider can be multi‑MB. */
function slimProvider(p: Record<string, unknown>): Record<string, unknown> {
  const modelsIn = (p.models || {}) as Record<string, { name?: string } | string>;
  const models: Record<string, { id: string; name?: string }> = {};
  if (modelsIn && typeof modelsIn === "object" && !Array.isArray(modelsIn)) {
    for (const [modelId, meta] of Object.entries(modelsIn)) {
      const name = typeof meta === "string" ? meta : meta?.name;
      models[modelId] = name ? { id: modelId, name } : { id: modelId };
    }
  }
  return {
    id: p.id ?? p.providerID ?? p.name,
    name: p.name,
    source: p.source,
    models,
  };
}

function normalizeCapabilities(
  sourceRunId: string,
  parts: {
    health?: unknown;
    config?: unknown;
    configProviders?: unknown;
    provider?: unknown;
    agents?: unknown;
    commands?: unknown;
  },
): RunnerCapabilities {
  const health = parts.health as { healthy?: boolean; version?: string } | undefined;
  const config = parts.config as { model?: string } | undefined;
  const provider = parts.provider as {
    all?: unknown[];
    default?: Record<string, string>;
    connected?: string[];
  } | undefined;
  const configProviders = parts.configProviders as {
    providers?: unknown[];
    default?: Record<string, string>;
  } | undefined;

  // Prefer /config/providers (connected, ~100KB) over /provider (all known, multi‑MB).
  const providerList = (
    configProviders?.providers ||
    provider?.all ||
    []
  ) as Array<Record<string, unknown>>;
  const slimProviders = providerList.map(slimProvider);

  const models: RunnerCapabilities["models"] = [];
  for (const p of slimProviders) {
    const providerID = String(p.id || "");
    const modelMap = (p.models || {}) as Record<string, { name?: string }>;
    for (const [modelId, meta] of Object.entries(modelMap)) {
      models.push({
        id: providerID ? `${providerID}/${modelId}` : modelId,
        providerID: providerID || undefined,
        name: meta?.name,
      });
    }
  }

  const defaults = provider?.default || configProviders?.default || {};
  const defaultModel =
    config?.model ||
    (typeof defaults === "object" ? Object.values(defaults)[0] : undefined) ||
    null;

  return {
    available: true,
    updatedAt: new Date().toISOString(),
    sourceRunId,
    version: health?.version ?? null,
    defaultModel: defaultModel ? String(defaultModel) : null,
    connectedProviders: provider?.connected || [],
    providers: slimProviders,
    models,
    agents: Array.isArray(parts.agents) ? parts.agents : [],
    commands: Array.isArray(parts.commands) ? parts.commands : [],
    // Omit raw provider dump — it can be multi‑MB and breaks DO persistence.
    raw: {
      health: parts.health,
      config: parts.config,
    },
  };
}

/** Singleton DO: stores last-seen OpenCode capabilities for harness discovery. */
export class CapabilitiesCache extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" || url.pathname.endsWith("/get")) {
      const stored = await this.ctx.storage.get<RunnerCapabilities>(CAPABILITIES_KEY);
      return json(stored ?? emptyCapabilities("No run has refreshed capabilities yet"));
    }
    if (request.method === "PUT" || request.method === "POST") {
      const body = (await request.json().catch(() => null)) as RunnerCapabilities | null;
      if (!body || typeof body !== "object") return json({ error: "Invalid body" }, 400);
      await this.ctx.storage.put(CAPABILITIES_KEY, body);
      return json({ ok: true, updatedAt: body.updatedAt });
    }
    return json({ error: "Method not allowed" }, 405);
  }
}

function capabilitiesStub(env: Env) {
  return env.CAPABILITIES.get(env.CAPABILITIES.idFromName("global"));
}

export type RunRegistryRecord = {
  runId: string;
  status: RunMeta["status"];
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  error?: string;
  repo?: string;
  branch?: string;
};

function runsRegistryStub(env: Env) {
  return env.RUNS_REGISTRY.get(env.RUNS_REGISTRY.idFromName("global"));
}

async function registryUpsert(
  env: Env,
  record: {
    runId: string;
    status: RunMeta["status"];
    createdAt?: number;
    updatedAt?: number;
    expiresAt?: number | null;
    error?: string | null;
    repo?: string | null;
    branch?: string | null;
  },
): Promise<void> {
  try {
    await runsRegistryStub(env).fetch(
      new Request("http://registry/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      }),
    );
  } catch (e) {
    console.error("registryUpsert failed", e);
  }
}

async function registryRemove(env: Env, runId: string): Promise<void> {
  try {
    await runsRegistryStub(env).fetch(
      new Request(`http://registry/?runId=${encodeURIComponent(runId)}`, {
        method: "DELETE",
      }),
    );
  } catch (e) {
    console.error("registryRemove failed", e);
  }
}

async function registryList(env: Env): Promise<RunRegistryRecord[]> {
  try {
    const resp = await runsRegistryStub(env).fetch(new Request("http://registry/"));
    const body = (await resp.json().catch(() => ({ runs: [] }))) as { runs?: RunRegistryRecord[] };
    return body.runs ?? [];
  } catch (e) {
    console.error("registryList failed", e);
    return [];
  }
}

/** Singleton DO: tracks active/recent runs for list/control APIs. */
export class RunsRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        runId TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        expiresAt INTEGER,
        error TEXT,
        repo TEXT,
        branch TEXT
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET") {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT runId, status, createdAt, updatedAt, expiresAt, error, repo, branch
           FROM runs ORDER BY updatedAt DESC`,
        )
        .toArray() as Array<Record<string, unknown>>;
      const runs: RunRegistryRecord[] = rows.map((r) => ({
        runId: String(r.runId),
        status: r.status as RunMeta["status"],
        createdAt: Number(r.createdAt),
        updatedAt: Number(r.updatedAt),
        expiresAt: r.expiresAt == null ? undefined : Number(r.expiresAt),
        error: r.error == null ? undefined : String(r.error),
        repo: r.repo == null ? undefined : String(r.repo),
        branch: r.branch == null ? undefined : String(r.branch),
      }));
      return json({ runs });
    }

    if (request.method === "PUT") {
      const body = (await request.json().catch(() => null)) as Partial<RunRegistryRecord> | null;
      if (!body?.runId || !body.status) return json({ error: "runId and status required" }, 400);
      const now = Date.now();
      const existing = this.ctx.storage.sql
        .exec(`SELECT createdAt FROM runs WHERE runId = ?`, body.runId)
        .toArray() as Array<{ createdAt: number }>;
      const createdAt = body.createdAt ?? existing[0]?.createdAt ?? now;
      const updatedAt = body.updatedAt ?? now;
      this.ctx.storage.sql.exec(
        `INSERT INTO runs (runId, status, createdAt, updatedAt, expiresAt, error, repo, branch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(runId) DO UPDATE SET
           status = excluded.status,
           updatedAt = excluded.updatedAt,
           expiresAt = COALESCE(excluded.expiresAt, runs.expiresAt),
           error = excluded.error,
           repo = COALESCE(excluded.repo, runs.repo),
           branch = COALESCE(excluded.branch, runs.branch),
           createdAt = runs.createdAt`,
        body.runId,
        body.status,
        createdAt,
        updatedAt,
        body.expiresAt ?? null,
        body.error ?? null,
        body.repo ?? null,
        body.branch ?? null,
      );
      return json({ ok: true, runId: body.runId, status: body.status, updatedAt });
    }

    if (request.method === "DELETE") {
      const runId = url.searchParams.get("runId") || url.pathname.split("/").filter(Boolean).pop();
      if (!runId) return json({ error: "runId required" }, 400);
      this.ctx.storage.sql.exec(`DELETE FROM runs WHERE runId = ?`, runId);
      return json({ ok: true, runId });
    }

    return json({ error: "Method not allowed" }, 405);
  }
}


/** Normalize owner/repo or URL to https://github.com/owner/repo.git (no credentials). */
function normalizeGitHubRepoUrl(repo: string): string {
  let s = repo.trim().replace(/\/+$/, "");
  if (!s) return s;
  // git@github.com:owner/repo(.git)
  const ssh = s.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2].replace(/\.git$/i, "")}.git`;
  // https://github.com/owner/repo(.git) or with optional credentials already present
  const https = s.match(/^https?:\/\/(?:[^@\/]+@)?github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i);
  if (https) return `https://github.com/${https[1]}/${https[2].replace(/\.git$/i, "")}.git`;
  // owner/repo
  const short = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (short) return `https://github.com/${short[1]}/${short[2]}.git`;
  return s;
}

/**
 * Embed token for git clone/fetch. Fine-grained PATs need username `x-access-token`
 * (classic `https://TOKEN@github.com/` often fails with "clone missing").
 * Never log the returned URL.
 */
function withGitHubToken(repoUrl: string, token: string | undefined): string {
  const t = (token || "").trim();
  if (!t) return repoUrl;
  const norm = normalizeGitHubRepoUrl(repoUrl);
  if (!/^https:\/\/github\.com\//i.test(norm)) return repoUrl;
  return norm.replace(/^https:\/\/github\.com\//i, `https://x-access-token:${t}@github.com/`);
}

/** Prefer per-run ephemeral token (App installation) over Worker GIT_TOKEN. */
function resolveGitToken(meta: RunMeta | null, env: Pick<Env, "GIT_TOKEN">): string {
  const fromRun = (meta?.gitToken || "").trim();
  if (fromRun) return fromRun;
  return (env.GIT_TOKEN || "").trim();
}

/** Strip secrets before returning run meta over the API. */
function publicRunMeta(
  meta: RunMeta | null,
): (Omit<RunMeta, "gitToken"> & { hasGitToken: boolean }) | null {
  if (!meta) return null;
  const { gitToken, ...rest } = meta;
  return {
    ...rest,
    hasGitToken: !!(gitToken && gitToken.trim()),
  };
}


function repoBasename(repo: string | undefined | null): string | null {
  if (!repo?.trim()) return null;
  const cleaned = repo.trim().replace(/\/+$/, "");
  const base = cleaned.split("/").pop() || "";
  const name = base.replace(/\.git$/i, "");
  return name || null;
}

/** OpenCode working directory for the first cloned repo (matches startup.sh). */
function worktreeDirectory(repo: string | undefined | null): string {
  const name = repoBasename(repo);
  return name ? `/home/dev/${name}` : "/home/dev";
}

export type PromptResult = {
  ok: boolean;
  sessionId?: string;
  promptAccepted?: boolean;
  title?: string;
  directory?: string;
  error?: string;
};

function standingPushInstruction(workBranch: string): string {
  return `

---
WORK BRANCH / PERSISTENCE (required after code changes):
- Use git branch \`${workBranch}\` (env WORK_BRANCH; already checked out when present).
- After any code changes: commit and \`git push -u origin ${workBranch}\`.
- Container disk is ephemeral on sleep — wake restores from this remote work branch.
- Not required in plan/read-only mode (no code changes / no push).
`;
}

function autoPrInstruction(workBranch: string, baseBranch?: string): string {
  const base = (baseBranch && baseBranch.trim()) || "main";
  return `

---
AUTO_PR (required):
After you finish the requested work (code changes complete), create a draft pull request:
1. Use the existing work branch \`${workBranch}\` (do not invent a random branch name).
2. Commit your changes with a clear message.
3. Push: \`git push -u origin ${workBranch}\`.
4. Open a **draft** PR with \`gh pr create --draft --base ${base} --head ${workBranch}\` (title + body summarizing the change). Prefer draft over ready-for-review.
5. Reply with the PR URL when done.
Do this only after the task work is done — not before.
`;
}

export type AutoPrAugmentResult = {
  prompt: string;
  autoPR: boolean;
  autoPRApplied: boolean;
  autoPRSkippedReason?: "plan-mode";
  pushInstructionApplied: boolean;
};

export type AugmentPromptOpts = {
  autoPR: boolean;
  agent?: string;
  workBranch: string;
  baseBranch?: string;
};

/**
 * Standing push instruction whenever there is a prompt (build/default).
 * Plan mode is read-only: no push / no autoPR append.
 * autoPR reuses the same work branch (no random branch names).
 */
export function augmentPromptForRun(
  prompt: string,
  opts: AugmentPromptOpts,
): AutoPrAugmentResult {
  const isPlanMode = (opts.agent || "").trim().toLowerCase() === "plan";
  const wantAutoPR = opts.autoPR === true;

  if (!prompt) {
    return {
      prompt,
      autoPR: wantAutoPR,
      autoPRApplied: false,
      pushInstructionApplied: false,
      ...(wantAutoPR && isPlanMode ? { autoPRSkippedReason: "plan-mode" as const } : {}),
    };
  }

  if (isPlanMode) {
    return {
      prompt,
      autoPR: wantAutoPR,
      autoPRApplied: false,
      pushInstructionApplied: false,
      ...(wantAutoPR ? { autoPRSkippedReason: "plan-mode" as const } : {}),
    };
  }

  let out = prompt + standingPushInstruction(opts.workBranch);
  let autoPRApplied = false;
  if (wantAutoPR) {
    out += autoPrInstruction(opts.workBranch, opts.baseBranch);
    autoPRApplied = true;
  }
  return {
    prompt: out,
    autoPR: wantAutoPR,
    autoPRApplied,
    pushInstructionApplied: true,
  };
}

/** @deprecated Prefer augmentPromptForRun (includes standing push + work branch). */
export function applyAutoPrToPrompt(
  prompt: string,
  autoPR: boolean,
  agent?: string,
  workBranch = "opencode/run",
  baseBranch?: string,
): AutoPrAugmentResult {
  return augmentPromptForRun(prompt, { autoPR, agent, workBranch, baseBranch });
}

export class OpenCodeRunner extends Container<Env> {
  defaultPort = 4096;
  // Idle → sleep/stop (keep DO / run id). Destroy only via DELETE (or hardDestroyOnExpiry).
  sleepAfter = "2h";
  enableInternet = true;
  // Required: empty entrypoint from the Containers runtime would clear the image ENTRYPOINT
  // and the instance exits immediately with "container just exited".
  entrypoint = ["/bin/bash", "/home/dev/startup.sh"];

  private startTime: number | null = null;

  private async loadMeta(): Promise<RunMeta | null> {
    return (await this.ctx.storage.get<RunMeta>("meta")) ?? null;
  }

  private async saveMeta(meta: RunMeta): Promise<void> {
    await this.ctx.storage.put("meta", meta);
  }

    private buildEnvVars(meta: RunMeta | null): Record<string, string> {
    const repo = meta?.repo?.trim();
    const branch = meta?.branch?.trim();
    const workBranch =
      meta?.workBranch?.trim() ||
      (meta?.runId ? workBranchName(meta.runId) : "");
    // Per-run App installation token (or request gitToken) wins over Worker GIT_TOKEN.
    const gitToken = resolveGitToken(meta, this.env);
    // Normalize + embed x-access-token so live containers clone fine-grained PATs
    // even before startup.sh insteadOf is rebuilt into the image.
    const rawRepos = repo || this.env.GIT_REPOS || "";
    const gitRepos = rawRepos
      ? rawRepos
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean)
          .map((r) => withGitHubToken(normalizeGitHubRepoUrl(r), gitToken || undefined))
          .join(",")
      : "";
    const setupCmds = (meta?.setup || []).map((c) => String(c).trim()).filter(Boolean);
    return {
      OPENCODE_PERMISSION: '{"edit":"allow","bash":"allow","write":"allow"}',
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_API_KEY: this.env.OPENCODE_API_KEY || "",
      GIT_REPOS: gitRepos,
      // Same secret under both names: clone tooling uses GIT_TOKEN; `gh` expects GH_TOKEN.
      GIT_TOKEN: gitToken,
      GH_TOKEN: gitToken,
      RUN_ID: meta?.runId || "",
      // Base / starting ref from the create request.
      RUN_BRANCH: branch || "",
      // Deterministic per-run work branch the agent must push; startup restores from it on wake.
      WORK_BRANCH: workBranch,
      // Prefer ||| — container env may not preserve newlines. startup.sh splits on ||| and newlines.
      SETUP_COMMANDS: setupCmds.join("|||"),
    };
  }

  private async applyEnvFromMeta(): Promise<RunMeta | null> {
    const meta = await this.loadMeta();
    this.envVars = this.buildEnvVars(meta);
    return meta;
  }

  private async scheduleExpiry(expiresAt: number): Promise<void> {
    await this.ctx.storage.setAlarm(expiresAt);
  }

  /**
   * Container SDK uses alarms for activity timeout / sleepAfter.
   * Soft TTL (expiresAt / maxLifetimeMs): stop/sleep and keep DO meta so /start works.
   * Hard destroy on TTL only when hardDestroyOnExpiry was set at bootstrap.
   * Explicit destroy remains DELETE /api/runs/:id (and admin destroy).
   */
  override async alarm(alarmProps?: { isRetry?: boolean; retryCount?: number }): Promise<void> {
    const meta = await this.loadMeta();
    const now = Date.now();
    if (meta?.expiresAt && now >= meta.expiresAt) {
      const hard = meta.hardDestroyOnExpiry === true;
      console.log(
        hard ? "Run lifetime TTL alarm → hard destroy" : "Run lifetime TTL alarm → soft stop/sleep",
        meta.runId,
      );
      if (hard) {
        try {
          await this.destroy();
        } catch (e) {
          console.error("Alarm destroy failed", e);
          try {
            await this.stop();
          } catch {
            /* ignore */
          }
        }
        meta.status = "destroyed";
        await this.saveMeta(meta);
        await registryUpsert(this.env, {
          runId: meta.runId,
          status: "destroyed",
          createdAt: meta.createdAt,
          expiresAt: meta.expiresAt,
          repo: meta.repo,
          branch: meta.branch,
        });
        return;
      }

      try {
        await this.stop();
      } catch (e) {
        console.error("Alarm soft-stop failed", e);
      }
      meta.status = "stopped";
      await this.saveMeta(meta);
      await registryUpsert(this.env, {
        runId: meta.runId,
        status: "stopped",
        createdAt: meta.createdAt,
        expiresAt: meta.expiresAt,
        repo: meta.repo,
        branch: meta.branch,
      });
      // Do not delete alarm storage meta — /start can wake the same run id.
      return;
    }
    // Important: do not swallow Container SDK sleep/activity alarms.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (super.alarm as (p?: unknown) => Promise<void>)(alarmProps);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/__admin/")) {
      return this.handleAdminRequest(request, url);
    }

    await this.applyEnvFromMeta();
    return super.fetch(request);
  }

  private async handleAdminRequest(request: Request, url: URL): Promise<Response> {
    const path = url.pathname.replace("/__admin", "");

    try {
      switch (path) {
        case "/status":
          return this.getStatus();
        case "/bootstrap":
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          return this.doBootstrap(request);
        case "/start":
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          return this.doStart(request);
        case "/git-token":
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          return this.doSetGitToken(request);
        case "/stop":
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          return this.doStop();
        case "/destroy":
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          return this.doDestroy();
        case "/restart":
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          return this.doRestart();
        case "/config":
          return this.getConfig();
        case "/refresh-capabilities":
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          return this.doRefreshCapabilities();
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  }

  private async containerJson(path: string): Promise<unknown> {
    const resp = await this.containerFetch(`http://127.0.0.1:${this.defaultPort}${path}`, this.defaultPort);
    if (!resp.ok) {
      throw new Error(`${path} returned ${resp.status}`);
    }
    return resp.json();
  }

  private async collectAndStoreCapabilities(runId: string): Promise<RunnerCapabilities> {
    const parts: {
      health?: unknown;
      config?: unknown;
      configProviders?: unknown;
      provider?: unknown;
      agents?: unknown;
      commands?: unknown;
    } = {};

    const settle = async (key: keyof typeof parts, path: string) => {
      try {
        parts[key] = await this.containerJson(path);
      } catch (e) {
        console.warn(`capabilities ${path} failed`, e);
      }
    };

    // Intentionally skip /provider (multi‑MB "all providers" catalog).
    // /config/providers covers connected providers + models for harness pickers.
    await Promise.all([
      settle("health", "/global/health"),
      settle("config", "/config"),
      settle("configProviders", "/config/providers"),
      settle("agents", "/agent"),
      settle("commands", "/command"),
    ]);

    const caps = normalizeCapabilities(runId, parts);
    if (!parts.health && !parts.provider && !parts.config) {
      caps.available = false;
      caps.error = "OpenCode did not return health/config/provider after start";
    }

    try {
      const body = JSON.stringify(caps);
      // DO values should stay well under ~1MB; refuse oversized snapshots early.
      if (body.length > 900_000) {
        caps.available = false;
        caps.error = `Capabilities payload too large (${body.length} bytes)`;
        caps.providers = [];
        caps.models = caps.models.slice(0, 200);
        caps.raw = { health: parts.health, config: parts.config };
      }
      const storeBody = JSON.stringify(caps);
      const storeResp = await capabilitiesStub(this.env).fetch(
        new Request("http://capabilities/store", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: storeBody,
        }),
      );
      if (!storeResp.ok) {
        const detail = await storeResp.text().catch(() => "");
        console.error("capabilities store failed", storeResp.status, detail.slice(0, 500));
        caps.error =
          caps.error ||
          `Failed to persist capabilities cache (${storeResp.status})`;
      }
    } catch (e) {
      console.error("Failed to persist capabilities cache", e);
      caps.error = caps.error || (e instanceof Error ? e.message : String(e));
    }

    return caps;
  }


  private async tryFetchCrashLog(): Promise<string | undefined> {
    for (let i = 0; i < 5; i++) {
      try {
        if (i > 0) await new Promise((r) => setTimeout(r, 1000));
        const running = this.ctx.container?.running ?? false;
        if (!running && i < 4) continue;
        const resp = await this.containerFetch(
          `http://127.0.0.1:${this.defaultPort}/__opencode-log`,
          this.defaultPort,
        );
        if (!resp.ok) continue;
        const text = await resp.text();
        // OpenCode SPA returns HTML for unknown routes when still running after a
        // failed clone (old images). Only accept plain startup/crash logs.
        if (!text) continue;
        const trimmed = text.trimStart();
        if (trimmed.startsWith("<!") || trimmed.startsWith("<html") || trimmed.startsWith("<HTML")) {
          continue;
        }
        return text.slice(0, 32_000);
      } catch {
        /* retry */
      }
    }
    return undefined;
  }

  private containerStartOptions(): {
    entrypoint: string[];
    envVars: Record<string, string>;
  } {
    return {
      entrypoint: ["/bin/bash", "/home/dev/startup.sh"],
      envVars: { ...(this.envVars || {}) },
    };
  }

  private async doRefreshCapabilities(): Promise<Response> {
    const meta = await this.applyEnvFromMeta();
    if (!meta?.runId) return json({ error: "No run meta" }, 400);
    await this.startAndWaitForPorts({
      ports: [this.defaultPort],
      cancellationOptions: { ...START_WAIT },
      startOptions: this.containerStartOptions(),
    });
    const capabilities = await this.collectAndStoreCapabilities(meta.runId);
    return json({ success: true, capabilities });
  }


  /**
   * Ensure a session exists in the cloned worktree directory.
   * Always creates a session (even without a prompt) so openCodeUrl can deep-link
   * into the project. Optionally sends prompt_async when prompt text is non-empty.
   * Also warms GET /project/current?directory= so the server registers the project.
   */
  private async ensureSession(opts: {
    repo?: string;
    prompt?: string;
    title?: string;
    model?: { providerID: string; modelID: string };
    agent?: string;
  }): Promise<PromptResult> {
    const directory = worktreeDirectory(opts.repo);
    const promptText = (opts.prompt || "").trim();
    const title =
      (opts.title && opts.title.trim()) ||
      (promptText ? promptText.slice(0, 80) : "") ||
      (opts.repo ? `Run · ${repoBasename(opts.repo) || "project"}` : "Run session");
    const model =
      opts.model?.providerID && opts.model?.modelID
        ? opts.model
        : { ...DEFAULT_PROMPT_MODEL };

    try {
      // Warm/register the project for this directory (pinned OpenCode supports this).
      try {
        await this.containerFetch(
          `http://127.0.0.1:${this.defaultPort}/project/current?directory=${encodeURIComponent(directory)}`,
          this.defaultPort,
        );
      } catch {
        /* best-effort */
      }

      const sessionResp = await this.containerFetch(
        new Request(
          `http://127.0.0.1:${this.defaultPort}/session?directory=${encodeURIComponent(directory)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title,
              ...(opts.agent ? { agent: opts.agent } : {}),
            }),
          },
        ),
        this.defaultPort,
      );
      if (!sessionResp.ok) {
        const body = await sessionResp.text().catch(() => "");
        return {
          ok: false,
          title,
          directory,
          error: `session create failed: ${sessionResp.status} ${body.slice(0, 500)}`,
        };
      }
      const session = (await sessionResp.json()) as { id?: string };
      const sessionId = session?.id;
      if (!sessionId) {
        return {
          ok: false,
          title,
          directory,
          error: "session create returned no id",
        };
      }

      // No prompt → session alone is enough for UI deep-link into the project.
      if (!promptText) {
        return {
          ok: true,
          sessionId,
          promptAccepted: false,
          title,
          directory,
        };
      }

      const promptBody: Record<string, unknown> = {
        parts: [{ type: "text", text: promptText }],
        model,
      };
      if (opts.agent) promptBody.agent = opts.agent;

      const promptResp = await this.containerFetch(
        new Request(
          `http://127.0.0.1:${this.defaultPort}/session/${encodeURIComponent(sessionId)}/prompt_async?directory=${encodeURIComponent(directory)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(promptBody),
          },
        ),
        this.defaultPort,
      );

      // OpenCode returns 204 when prompt_async is accepted
      if (promptResp.status === 204 || promptResp.ok) {
        return {
          ok: true,
          sessionId,
          promptAccepted: true,
          title,
          directory,
        };
      }
      const errBody = await promptResp.text().catch(() => "");
      return {
        ok: false,
        sessionId,
        promptAccepted: false,
        title,
        directory,
        error: `prompt_async failed: ${promptResp.status} ${errBody.slice(0, 500)}`,
      };
    } catch (e) {
      return {
        ok: false,
        title,
        directory,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** True when the worktree directory exists inside the container (clone succeeded). */
  private async worktreeExists(directory: string): Promise<boolean> {
    if (!directory || directory === "/home/dev") return true;
    const base = directory.replace(/\/+$/, "").split("/").pop();
    if (!base) return false;
    try {
      const listResp = await this.containerFetch(
        `http://127.0.0.1:${this.defaultPort}/file?path=${encodeURIComponent("/home/dev")}&directory=${encodeURIComponent("/home/dev")}`,
        this.defaultPort,
      );
      if (!listResp.ok) return false;
      const entries = (await listResp.json()) as Array<{ name?: string; type?: string }>;
      return entries.some((e) => e.name === base && e.type === "directory");
    } catch {
      return false;
    }
  }

  private async doBootstrap(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      runId?: string;
      repo?: string;
      branch?: string;
      /** Soft lifetime for stop/sleep (not destroy) unless hardDestroyOnExpiry. */
      maxLifetimeMs?: number;
      /** If true, TTL alarm destroys instead of stop/sleep. Default false. */
      hardDestroyOnExpiry?: boolean;
      prompt?: string;
      title?: string;
      model?: { providerID: string; modelID: string };
      agent?: string;
      setup?: string[];
      /** Cursor-like: append draft-PR instructions after the task (skipped in plan mode). */
      autoPR?: boolean;
      /** Cursor alias for autoPR. */
      autoCreatePR?: boolean;
      /** Ephemeral GitHub App installation token (or PAT). Alias: ghToken. */
      gitToken?: string;
      /** Alias for gitToken (`gh` env name). */
      ghToken?: string;
    };

    const runId = sanitizeRunId(body.runId || "");
    if (!runId) return json({ error: "Invalid runId" }, 400);

    const setup = Array.isArray(body.setup)
      ? body.setup.map((c) => String(c)).filter((c) => c.trim())
      : undefined;

    const wantAutoPR = body.autoPR === true || body.autoCreatePR === true;

    const maxLifetimeMs = Math.min(
      Math.max(Number(body.maxLifetimeMs || this.env.MAX_RUN_LIFETIME_MS || FOUR_HOURS_MS), 60_000),
      FOUR_HOURS_MS,
    );
    const createdAt = Date.now();
    const expiresAt = createdAt + maxLifetimeMs;

    const workBranch = workBranchName(runId);
    const meta: RunMeta = {
      runId,
      repo: body.repo,
      branch: body.branch,
      workBranch,
      setup,
      createdAt,
      expiresAt,
      hardDestroyOnExpiry: body.hardDestroyOnExpiry === true,
      status: "starting",
      autoPR: wantAutoPR,
      gitToken: (body.gitToken || body.ghToken || "").trim() || undefined,
    };
    await this.saveMeta(meta);
    await this.scheduleExpiry(expiresAt);
    await registryUpsert(this.env, {
      runId,
      status: "starting",
      createdAt,
      expiresAt,
      repo: body.repo,
      branch: body.branch,
      error: null,
    });

    this.envVars = this.buildEnvVars(meta);

    try {
      await this.startAndWaitForPorts({
        ports: [this.defaultPort],
        cancellationOptions: { ...START_WAIT },
        startOptions: this.containerStartOptions(),
      });

      // Detect crash keep-alive (opencode exited but port still answers).
      let crashed = false;
      let crashLog: string | undefined;
      try {
        const health = (await this.containerJson("/global/health")) as {
          healthy?: boolean;
          crash?: boolean;
        };
        if (health?.crash === true) {
          crashed = true;
          crashLog = await this.tryFetchCrashLog();
        }
      } catch {
        /* health probe optional here; capabilities path also checks */
      }

      if (crashed) {
        meta.status = "error";
        const cloneFailed =
          typeof crashLog === "string" &&
          (crashLog.includes("clone failed") || crashLog.includes("Failed to clone"));
        meta.error = cloneFailed
          ? "Repo clone failed (check repo URL / GIT_TOKEN for private repos). See crashLog."
          : "OpenCode process exited; crash keep-alive is serving health";
        await this.saveMeta(meta);
        await registryUpsert(this.env, {
          runId,
          status: "error",
          createdAt,
          expiresAt,
          repo: body.repo,
          branch: body.branch,
          error: meta.error,
        });
        return json(
          {
            success: false,
            runId,
            status: meta.status,
            error: meta.error,
            crashLog,
          },
          500,
        );
      }

      meta.status = "ready";
      await this.saveMeta(meta);
      await registryUpsert(this.env, {
        runId,
        status: "ready",
        createdAt,
        expiresAt,
        repo: body.repo,
        branch: body.branch,
        error: null,
      });

      // Capture models/agents/providers for harness-router (served later without an instance).
      const capabilities = await this.collectAndStoreCapabilities(runId);

      // Always pin directory on meta when a repo was requested (UI deep links / redirects).
      const directory = worktreeDirectory(body.repo);
      meta.directory = directory;
      await this.saveMeta(meta);

      // If a repo was requested, the worktree must exist — otherwise the UI shows $HOME
      // (.cache/.config/.local/.npm) and there is no project to open.
      if (body.repo && body.repo.trim()) {
        const present = await this.worktreeExists(directory);
        if (!present) {
          meta.status = "error";
          meta.error =
            `Clone missing at ${directory}. Check repo URL / GIT_TOKEN (private repos) / startup logs.`;
          await this.saveMeta(meta);
          await registryUpsert(this.env, {
            runId,
            status: "error",
            createdAt,
            expiresAt,
            repo: body.repo,
            branch: body.branch,
            error: meta.error,
          });
          const crashLog = await this.tryFetchCrashLog();
          return json(
            {
              success: false,
              runId,
              status: meta.status,
              error: meta.error,
              directory,
              ...(crashLog ? { crashLog } : {}),
            },
            500,
          );
        }
      }

      let prompt: PromptResult | undefined;
      const promptText = typeof body.prompt === "string" ? body.prompt.trim() : "";
      const autoPr = augmentPromptForRun(promptText, {
        autoPR: wantAutoPR,
        agent: body.agent,
        workBranch,
        baseBranch: body.branch,
      });
      // Always create a session in the worktree (even without a prompt) so openCodeUrl
      // can deep-link into the API-started project/session.
      if (body.repo && body.repo.trim()) {
        prompt = await this.ensureSession({
          repo: body.repo,
          prompt: autoPr.prompt || undefined,
          title: body.title,
          model: body.model,
          agent: body.agent,
        });
        if (prompt.sessionId) {
          meta.sessionId = prompt.sessionId;
          if (prompt.directory) meta.directory = prompt.directory;
          await this.saveMeta(meta);
        }
      }

      return json({

        success: true,
        runId,
        status: meta.status,
        createdAt,
        expiresAt,
        expiresAtIso: new Date(expiresAt).toISOString(),
        sleepAfter: this.sleepAfter,
        workBranch,
        branch: body.branch || null,
        capabilities,
        autoPR: autoPr.autoPR,
        autoPRApplied: autoPr.autoPRApplied,
        pushInstructionApplied: autoPr.pushInstructionApplied,
        ...(autoPr.autoPRSkippedReason
          ? { autoPRSkippedReason: autoPr.autoPRSkippedReason }
          : {}),
        directory: meta.directory || directory,
        sessionId: meta.sessionId || prompt?.sessionId,
        ...(prompt
          ? {
              prompt,
              promptAccepted: prompt.promptAccepted ?? prompt.ok,
            }
          : {}),
      });
    } catch (error) {
      meta.status = "error";
      meta.error = error instanceof Error ? error.message : String(error);
      await this.saveMeta(meta);
      await registryUpsert(this.env, {
        runId,
        status: "error",
        createdAt,
        expiresAt,
        repo: body.repo,
        branch: body.branch,
        error: meta.error,
      });
      const crashLog = await this.tryFetchCrashLog();
      return json(
        {
          success: false,
          runId,
          status: meta.status,
          error: meta.error,
          ...(crashLog ? { crashLog } : {}),
        },
        500,
      );
    }
  }

  private async getStatus(): Promise<Response> {
    const state = await this.getState();
    const running = this.ctx.container?.running ?? false;
    const meta = await this.loadMeta();

    return json({
      status: state.status,
      running,
      lastChange: state.lastChange,
      lastChangeFormatted: new Date(state.lastChange).toISOString(),
      exitCode: "exitCode" in state ? state.exitCode : null,
      uptime: this.startTime ? Date.now() - this.startTime : null,
      sleepAfter: this.sleepAfter,
      defaultPort: this.defaultPort,
      enableInternet: this.enableInternet,
      run: publicRunMeta(meta),
    });
  }


  /** Refresh ephemeral GitHub token for wake / long runs (App installation tokens expire ~1h). */
  private async doSetGitToken(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      gitToken?: string;
      ghToken?: string;
    };
    const token = (body.gitToken || body.ghToken || "").trim();
    if (!token) return json({ error: "gitToken required" }, 400);
    const meta = await this.loadMeta();
    if (!meta || meta.status === "destroyed") {
      return json({ error: "Run not found" }, 404);
    }
    meta.gitToken = token;
    await this.saveMeta(meta);
    // Re-apply env for next start/wake; live container env is not mutated in-place.
    this.envVars = this.buildEnvVars(meta);
    return json({
      success: true,
      runId: meta.runId,
      hasRunGitToken: true,
      note: "Token stored for next start/wake. Live container env is unchanged until start/restart.",
    });
  }

  private async doStart(request?: Request): Promise<Response> {
    if (request) {
      const body = (await request.json().catch(() => ({}))) as {
        gitToken?: string;
        ghToken?: string;
      };
      const token = (body.gitToken || body.ghToken || "").trim();
      if (token) {
        const existing = await this.loadMeta();
        if (existing) {
          existing.gitToken = token;
          await this.saveMeta(existing);
        }
      }
    }
    const meta = await this.applyEnvFromMeta();
    if (meta) {
      meta.status = "starting";
      await this.saveMeta(meta);
      await registryUpsert(this.env, {
        runId: meta.runId,
        status: "starting",
        createdAt: meta.createdAt,
        expiresAt: meta.expiresAt,
        repo: meta.repo,
        branch: meta.branch,
      });
    }
    try {
      await this.startAndWaitForPorts({
        ports: [this.defaultPort],
        cancellationOptions: { ...START_WAIT },
        startOptions: this.containerStartOptions(),
      });
      if (meta) {
        meta.status = "ready";
        meta.error = undefined;
        await this.saveMeta(meta);
        await registryUpsert(this.env, {
          runId: meta.runId,
          status: "ready",
          createdAt: meta.createdAt,
          expiresAt: meta.expiresAt,
          repo: meta.repo,
          branch: meta.branch,
          error: null,
        });
      }
      return json({ success: true, message: "Container started successfully" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (meta) {
        meta.status = "error";
        meta.error = msg;
        await this.saveMeta(meta);
        await registryUpsert(this.env, {
          runId: meta.runId,
          status: "error",
          createdAt: meta.createdAt,
          expiresAt: meta.expiresAt,
          repo: meta.repo,
          branch: meta.branch,
          error: msg,
        });
      }
      const crashLog = await this.tryFetchCrashLog();
      return json({ success: false, error: msg, ...(crashLog ? { crashLog } : {}) }, 500);
    }
  }

  private async doStop(): Promise<Response> {
    await this.stop();
    const meta = await this.loadMeta();
    if (meta) {
      meta.status = "stopped";
      await this.saveMeta(meta);
      await registryUpsert(this.env, {
        runId: meta.runId,
        status: "stopped",
        createdAt: meta.createdAt,
        expiresAt: meta.expiresAt,
        repo: meta.repo,
        branch: meta.branch,
      });
    }
    return json({ success: true, message: "Container stop signal sent" });
  }

  private async doDestroy(): Promise<Response> {
    try {
      await this.destroy();
    } catch {
      await this.stop();
    }
    const meta = await this.loadMeta();
    if (meta) {
      meta.status = "destroyed";
      meta.gitToken = undefined;
      await this.saveMeta(meta);
      await registryUpsert(this.env, {
        runId: meta.runId,
        status: "destroyed",
        createdAt: meta.createdAt,
        expiresAt: meta.expiresAt,
        repo: meta.repo,
        branch: meta.branch,
      });
    }
    await this.ctx.storage.deleteAlarm();
    return json({ success: true, message: "Container destroyed" });
  }

  private async doRestart(): Promise<Response> {
    const meta = await this.applyEnvFromMeta();
    if (meta) {
      meta.status = "starting";
      await this.saveMeta(meta);
      await registryUpsert(this.env, {
        runId: meta.runId,
        status: "starting",
        createdAt: meta.createdAt,
        expiresAt: meta.expiresAt,
        repo: meta.repo,
        branch: meta.branch,
      });
    }
    try {
      await this.stop();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await this.applyEnvFromMeta();
    try {
      await this.startAndWaitForPorts({
        ports: [this.defaultPort],
        cancellationOptions: { ...START_WAIT },
        startOptions: this.containerStartOptions(),
      });
      if (meta) {
        meta.status = "ready";
        meta.error = undefined;
        await this.saveMeta(meta);
        await registryUpsert(this.env, {
          runId: meta.runId,
          status: "ready",
          createdAt: meta.createdAt,
          expiresAt: meta.expiresAt,
          repo: meta.repo,
          branch: meta.branch,
          error: null,
        });
      }
      return json({ success: true, message: "Container restarted successfully" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (meta) {
        meta.status = "error";
        meta.error = msg;
        await this.saveMeta(meta);
        await registryUpsert(this.env, {
          runId: meta.runId,
          status: "error",
          createdAt: meta.createdAt,
          expiresAt: meta.expiresAt,
          repo: meta.repo,
          branch: meta.branch,
          error: msg,
        });
      }
      const crashLog = await this.tryFetchCrashLog();
      return json({ success: false, error: msg, ...(crashLog ? { crashLog } : {}) }, 500);
    }
  }

  private async getConfig(): Promise<Response> {
    const meta = await this.loadMeta();
    return json({
      envVars: {
        GIT_REPOS: meta?.repo || this.env.GIT_REPOS || "",
        hasApiKey: !!this.env.OPENCODE_API_KEY,
        hasGitToken: !!resolveGitToken(meta, this.env),
        hasWorkerGitToken: !!this.env.GIT_TOKEN,
        hasRunGitToken: !!(meta?.gitToken && meta.gitToken.trim()),
        auth: "cloudflare-access",
      },
      containerConfig: {
        defaultPort: this.defaultPort,
        sleepAfter: this.sleepAfter,
        enableInternet: this.enableInternet,
        maxLifetimeMs: Number(this.env.MAX_RUN_LIFETIME_MS || FOUR_HOURS_MS),
        softExpiryPolicy: "stop",
        destroyPolicy: "explicit-delete-or-hardDestroyOnExpiry",
      },
      run: publicRunMeta(meta),
    });
  }

  override onStart() {
    this.startTime = Date.now();
    console.log("OpenCode container started");
  }

  override onStop() {
    this.startTime = null;
    console.log("OpenCode container stopped");
  }

  override onError(error: unknown) {
    console.error("OpenCode container error:", error);
    throw error;
  }
}

const app = new Hono<{ Bindings: Env }>();

function runUrl(requestUrl: string, runId: string): string {
  const u = new URL(requestUrl);
  return `${u.origin}/r/${encodeURIComponent(runId)}/`;
}

/**
 * OpenCode client encodes project directory as base64url (no padding), matching
 * the SPA helper cn(dir) = btoa(dir).replace(/+/g,'-').replace(/\//g,'_').replace(/=/g,'').
 */
function encodeOpenCodeDir(directory: string): string {
  // Paths are ASCII (/home/dev/...); btoa matches the browser OpenCode bundle.
  return btoa(directory).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Client route after /r/:runId strip: /${cn(directory)}/session/${sessionId} */
function sessionDeepPath(directory: string, sessionId: string): string {
  return `/${encodeOpenCodeDir(directory)}/session/${encodeURIComponent(sessionId)}`;
}

/** Public UI URL deep-linking into an auto-started session (still under /r/:runId/). */
function runSessionUrl(
  originOrRequestUrl: string,
  runId: string,
  directory: string,
  sessionId: string,
): string {
  const origin = originOrRequestUrl.includes("://")
    ? new URL(originOrRequestUrl).origin
    : originOrRequestUrl;
  return `${origin}/r/${encodeURIComponent(runId)}${sessionDeepPath(directory, sessionId)}`;
}

/** Project route (no session yet): /${cn(directory)}/session under /r/:runId/. */
function projectDeepPath(directory: string): string {
  return `/${encodeOpenCodeDir(directory)}/session`;
}

function runProjectUrl(originOrRequestUrl: string, runId: string, directory: string): string {
  const origin = originOrRequestUrl.includes("://")
    ? new URL(originOrRequestUrl).origin
    : originOrRequestUrl;
  return `${origin}/r/${encodeURIComponent(runId)}${projectDeepPath(directory)}`;
}

/**
 * Prefer session deep link when meta has sessionId + directory.
 * Else open the project session route so the UI shows the worktree (not $HOME).
 */
function openCodeUiUrl(
  requestUrl: string,
  runId: string,
  opts?: { sessionId?: string | null; directory?: string | null },
): string {
  const sessionId = opts?.sessionId?.trim();
  const directory = opts?.directory?.trim();
  if (sessionId && directory) {
    return runSessionUrl(requestUrl, runId, directory, sessionId);
  }
  if (directory && directory !== "/home/dev") {
    return runProjectUrl(requestUrl, runId, directory);
  }
  return runUrl(requestUrl, runId);
}

const OC_RUN_COOKIE = "oc_run";
const OC_RUN_COOKIE_MAX_AGE = 14400; // match default 4h run TTL

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function ocRunCookieHeader(runId: string): string {
  return `${OC_RUN_COOKIE}=${encodeURIComponent(runId)}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${OC_RUN_COOKIE_MAX_AGE}`;
}

function clearOcRunCookieHeader(): string {
  return `${OC_RUN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0`;
}

/** Build CSP-safe router shim served from the Worker (not the container).
 * OpenCode's Solid router reads location.pathname and pushState('/') — without a
 * base-path flag we strip /r/:runId for the app and re-prefix history writes.
 */
function ocShimScript(runId: string): string {
  // runId already sanitized ([A-Za-z0-9_-]); still JSON-encode for JS string safety.
  const idLit = JSON.stringify(runId);
  return `(() => {
  const RUN = ${idLit};
  const PREFIX = "/r/" + RUN;
  function stripPath(p) {
    if (typeof p !== "string") return p;
    if (p === PREFIX || p === PREFIX + "/") return "/";
    if (p.startsWith(PREFIX + "/")) return p.slice(PREFIX.length) || "/";
    return p;
  }
  function prefixPath(url, title, unused) {
    // history.*(state, title, url) — only rewrite same-origin path URLs
    if (typeof url !== "string") return [url, title, unused];
    try {
      const u = new URL(url, location.href);
      if (u.origin !== location.origin) return [url, title, unused];
      let path = u.pathname;
      if (path === PREFIX || path.startsWith(PREFIX + "/")) {
        return [url, title, unused];
      }
      if (!path.startsWith("/")) return [url, title, unused];
      const next = PREFIX + (path === "/" ? "/" : path) + u.search + u.hash;
      return [next, title, unused];
    } catch {
      return [url, title, unused];
    }
  }
  window.__ocStripPath = stripPath;
  const _push = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState = function (state, title, url) {
    const a = prefixPath(url, title, state);
    // prefixPath returns [url, title, unused] — restore (state, title, url) order
    return _push(state, title, a[0]);
  };
  history.replaceState = function (state, title, url) {
    const a = prefixPath(url, title, state);
    return _replace(state, title, a[0]);
  };
  try {
    const desc = Object.getOwnPropertyDescriptor(Location.prototype, "pathname");
    if (desc && desc.get && desc.configurable) {
      Object.defineProperty(Location.prototype, "pathname", {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          return stripPath(desc.get.call(this));
        },
      });
    }
  } catch (_) {}
})();
`;
}

function ocShimResponse(runId: string): Response {
  return new Response(ocShimScript(runId), {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": ocRunCookieHeader(runId),
    },
  });
}

/**
 * Prepare OpenCode SPA HTML for serving under /r/:runId/.
 * - Strip PWA manifest (Access breaks cookieless manifest fetches)
 * - Rewrite root-absolute href/src to /r/:runId/... (skip protocol-relative //)
 * - Inject external router shim early in <head> (CSP-safe; no inline script)
 */
function prepareProxiedHtml(html: string, runId: string): string {
  const prefix = `/r/${runId}`;
  let out = html.replace(/<link\b[^>]*\brel=(["'])manifest\1[^>]*>\s*/gi, "");

  out = out.replace(
    /\b(href|src)=(["'])\/(?!\/)([^"']*)\2/gi,
    (_m, attr: string, q: string, rest: string) => {
      // rest is path after leading /; skip if already under this run prefix
      if (
        rest === `r/${runId}` ||
        rest.startsWith(`r/${runId}/`) ||
        rest.startsWith(`r/${runId}?`) ||
        rest.startsWith(`r/${runId}#`)
      ) {
        return `${attr}=${q}/${rest}${q}`;
      }
      return `${attr}=${q}${prefix}/${rest}${q}`;
    },
  );

  // Avoid double-prefix if rewrite matched paths that already had /r/runId
  out = out.replaceAll(`${prefix}${prefix}/`, `${prefix}/`);

  const shimTag = `<script src="${prefix}/__oc-shim.js"></script>`;
  if (out.includes(`${prefix}/__oc-shim.js`)) {
    return out;
  }
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>${shimTag}`);
  } else {
    out = shimTag + out;
  }
  return out;
}

/** Rewrite location.pathname reads in OpenCode JS bundles to use the strip helper. */
function rewriteProxiedJs(js: string): string {
  let out = js;
  // window.location.pathname → window.__ocStripPath(window.location.pathname)
  out = out.replace(
    /(?<!__ocStripPath\()window\.location\.pathname\b/g,
    "window.__ocStripPath(window.location.pathname)",
  );
  // location.pathname → window.__ocStripPath(location.pathname) (skip window. and already wrapped)
  out = out.replace(
    /(?<!__ocStripPath\()(?<!window\.)location\.pathname\b/g,
    "window.__ocStripPath(location.pathname)",
  );
  return out;
}

async function proxyToRun(
  env: Env,
  runId: string,
  request: Request,
  opts?: { setStickyCookie?: boolean; rewriteHtml?: boolean; rewriteJs?: boolean },
): Promise<Response> {
  const url = new URL(request.url);
  // Container expects root paths (/assets/..., /global/health, etc.)
  const target = new URL(url.pathname + url.search, "http://container");
  const headers = new Headers(request.headers);
  headers.delete("host");

  const container = getContainer(env.OPENCODE_CONTAINER, runId);
  const upstream = await container.fetch(
    new Request(target.toString(), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    }),
  );

  const ct = (upstream.headers.get("content-type") || "").toLowerCase();
  const setCookie = opts?.setStickyCookie !== false && upstream.ok;
  const wantHtml =
    (opts?.rewriteHtml !== false) &&
    upstream.ok &&
    ct.includes("text/html");
  const pathEndsJs = url.pathname.endsWith(".js");
  const wantJs =
    (opts?.rewriteJs === true || (opts?.rewriteJs !== false && pathEndsJs)) &&
    upstream.ok &&
    (ct.includes("javascript") || ct.includes("ecmascript") || pathEndsJs) &&
    !wantHtml;

  if (!setCookie && !wantHtml && !wantJs) {
    return upstream;
  }

  const outHeaders = new Headers(upstream.headers);
  if (setCookie) {
    outHeaders.append("Set-Cookie", ocRunCookieHeader(runId));
  }

  if (wantHtml) {
    const html = await upstream.text();
    const prepared = prepareProxiedHtml(html, runId);
    outHeaders.delete("content-length");
    return new Response(prepared, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  }

  if (wantJs) {
    const js = await upstream.text();
    const prepared = rewriteProxiedJs(js);
    outHeaders.delete("content-length");
    return new Response(prepared, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

function requireRunnerAuth(c: { req: { header: (n: string) => string | undefined }; env: Env }): boolean {
  const token = c.env.RUNNER_API_TOKEN;
  if (!token) {
    // If no runner token configured, rely on Cloudflare Access alone
    return true;
  }
  const header = c.req.header("Authorization") || "";
  const expected = `Bearer ${token}`;
  return header === expected;
}

app.get("/worker-health", (c) => {
  return c.json({
    status: "ok",
    service: "opencode-worker",
    mode: "per-run",
    maxInstances: 4,
    maxLifetimeMs: Number(c.env.MAX_RUN_LIFETIME_MS || FOUR_HOURS_MS),
    sleepAfter: "2h",
    destroyPolicy: "explicit-delete",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/*", cors());

/**
 * OpenCode UI calls /api/* at host root (e.g. /api/health). That collides with the
 * runner control-plane. If the browser has oc_run and is NOT presenting the runner
 * bearer token, proxy to the container. Runner routes (/api/runs*, /api/capabilities)
 * and bearer-authenticated /api/health stay on the Worker.
 */
app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const isRunnerExclusive =
    path === "/api/runs" ||
    path.startsWith("/api/runs/") ||
    path === "/api/capabilities";
  if (isRunnerExclusive) return next();

  const hasRunnerBearer = requireRunnerAuth(c);
  if (path === "/api/health" && hasRunnerBearer) return next();

  const sticky = sanitizeRunId(parseCookies(c.req.header("Cookie"))[OC_RUN_COOKIE] || "");
  if (sticky) {
    return proxyToRun(c.env, sticky, c.req.raw, {
      setStickyCookie: true,
      rewriteHtml: false,
    });
  }
  return next();
});

/** Control-plane health for harness-router (no container). */
app.get("/api/health", async (c) => {
  if (!requireRunnerAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  let capabilities = emptyCapabilities();
  try {
    const resp = await capabilitiesStub(c.env).fetch(new Request("http://capabilities/get"));
    capabilities = (await resp.json()) as RunnerCapabilities;
  } catch {
    /* ignore */
  }
  return c.json({
    ok: true,
    mode: "per-run",
    maxInstances: 4,
    maxLifetimeMs: Number(c.env.MAX_RUN_LIFETIME_MS || FOUR_HOURS_MS),
    capabilitiesAvailable: !!capabilities.available,
    capabilitiesUpdatedAt: capabilities.updatedAt,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Last-seen OpenCode models/agents/providers.
 * Populated automatically on each successful POST /api/runs bootstrap.
 * Does not start a container.
 */
app.get("/api/capabilities", async (c) => {
  if (!requireRunnerAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const resp = await capabilitiesStub(c.env).fetch(new Request("http://capabilities/get"));
  const body = await resp.text();
  return new Response(body, {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
});

export type CreateRunBody = {
  runId?: string;
  repo?: string;
  branch?: string;
  /** Soft lifetime (stop/sleep on expiry). Default 4h. */
  maxLifetimeMs?: number;
  /** If true, TTL destroys the run. Default false — use DELETE to destroy. */
  hardDestroyOnExpiry?: boolean;
  prompt?: string;
  title?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  setup?: string[];
  /** Cursor-like: append draft-PR instructions after the task (skipped in plan mode). */
  autoPR?: boolean;
  /** Cursor alias for autoPR — either true enables. */
  autoCreatePR?: boolean;
  /**
   * Ephemeral GitHub token for this run (App installation token preferred).
   * Injected as GIT_TOKEN + GH_TOKEN; preferred over Worker GIT_TOKEN.
   * Never logged or returned from GET status. Alias: ghToken.
   */
  gitToken?: string;
  /** Alias for gitToken. */
  ghToken?: string;
};

/** Shared bootstrap for POST /api/runs (bearer) and POST /admin/api/create (Access). */
async function createRunResponse(
  env: Env,
  requestUrl: string,
  body: CreateRunBody,
): Promise<Response> {
  const runId = sanitizeRunId(body.runId || crypto.randomUUID());
  if (!runId) return json({ error: "Invalid runId" }, 400);

  const container = getContainer(env.OPENCODE_CONTAINER, runId);
  const bootstrap = await container.fetch(
    new Request("http://localhost/__admin/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        repo: body.repo,
        branch: body.branch,
        maxLifetimeMs: body.maxLifetimeMs,
        hardDestroyOnExpiry: body.hardDestroyOnExpiry,
        prompt: body.prompt,
        title: body.title,
        model: body.model,
        agent: body.agent,
        setup: body.setup,
        autoPR: body.autoPR === true || body.autoCreatePR === true,
        gitToken: body.gitToken || body.ghToken,
      }),
    }),
  );

  const payload = (await bootstrap.json().catch(() => ({}))) as Record<string, unknown>;
  const prompt = payload.prompt as PromptResult | undefined;
  const sessionId =
    (typeof payload.sessionId === "string" && payload.sessionId) ||
    prompt?.sessionId ||
    undefined;
  const directory =
    (typeof payload.directory === "string" && payload.directory) ||
    (typeof prompt?.directory === "string" && prompt.directory) ||
    (body.repo ? worktreeDirectory(body.repo) : undefined);
  const url = openCodeUiUrl(requestUrl, runId, { sessionId, directory });
  // Asset/API links stay on the run root (not the session deep path).
  const rootUrl = runUrl(requestUrl, runId);

  if (!bootstrap.ok) {
    // On failure (e.g. clone missing), do not deep-link into a non-existent project.
    const failUrl = rootUrl;
    return new Response(JSON.stringify({ ...payload, url: failUrl, openCodeUrl: failUrl }), {
      status: bootstrap.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      ...payload,
      url,
      openCodeUrl: url,
      links: {
        ui: url,
        health: `${rootUrl}global/health`,
        openapi: `${rootUrl}doc`,
        capabilities: new URL("/api/capabilities", requestUrl).toString(),
      },
    }),
    {
      status: 201,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/** Create / ensure a per-run OpenCode instance. Returns a UI link for harness-router. */
app.post("/api/runs", async (c) => {
  if (!requireRunnerAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as CreateRunBody;
  return createRunResponse(c.env, c.req.url, body);
});

/** List runs from the registry (no container start). */
app.get("/api/runs", async (c) => {
  if (!requireRunnerAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const runs = await registryList(c.env);
  return c.json({ runs });
});

app.post("/api/runs/:runId/start", async (c) => {
  if (!requireRunnerAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.json({ error: "Invalid runId" }, 400);
  const container = getContainer(c.env.OPENCODE_CONTAINER, runId);
  const bodyText = await c.req.text().catch(() => "");
  return container.fetch(
    new Request("http://localhost/__admin/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyText || "{}",
    }),
  );
});

/** Refresh ephemeral gitToken for an existing run (for wake / >1h App tokens). */
app.post("/api/runs/:runId/git-token", async (c) => {
  if (!requireRunnerAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.json({ error: "Invalid runId" }, 400);
  const container = getContainer(c.env.OPENCODE_CONTAINER, runId);
  const bodyText = await c.req.text().catch(() => "");
  return container.fetch(
    new Request("http://localhost/__admin/git-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyText || "{}",
    }),
  );
});

app.post("/api/runs/:runId/stop", async (c) => {
  if (!requireRunnerAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.json({ error: "Invalid runId" }, 400);
  const container = getContainer(c.env.OPENCODE_CONTAINER, runId);
  return container.fetch(new Request("http://localhost/__admin/stop", { method: "POST" }));
});

app.post("/api/runs/:runId/restart", async (c) => {
  if (!requireRunnerAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.json({ error: "Invalid runId" }, 400);
  const container = getContainer(c.env.OPENCODE_CONTAINER, runId);
  return container.fetch(new Request("http://localhost/__admin/restart", { method: "POST" }));
});

app.post("/api/runs/:runId/refresh-capabilities", async (c) => {
  if (!requireRunnerAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.json({ error: "Invalid runId" }, 400);
  const container = getContainer(c.env.OPENCODE_CONTAINER, runId);
  return container.fetch(
    new Request("http://localhost/__admin/refresh-capabilities", { method: "POST" }),
  );
});

app.get("/api/runs/:runId", async (c) => {
  if (!requireRunnerAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.json({ error: "Invalid runId" }, 400);

  const container = getContainer(c.env.OPENCODE_CONTAINER, runId);
  const statusResp = await container.fetch(new Request("http://localhost/__admin/status"));
  const status = (await statusResp.json().catch(() => ({}))) as Record<string, unknown>;
  const runMeta = (status.run || null) as RunMeta | null;
  const url = openCodeUiUrl(c.req.url, runId, {
    sessionId: runMeta?.sessionId,
    directory:
      runMeta?.directory ||
      (runMeta?.repo ? worktreeDirectory(runMeta.repo) : undefined),
  });
  return c.json({ runId, url, openCodeUrl: url, ...status });
});

app.delete("/api/runs/:runId", async (c) => {
  if (!requireRunnerAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.json({ error: "Invalid runId" }, 400);

  const container = getContainer(c.env.OPENCODE_CONTAINER, runId);
  const destroyResp = await container.fetch(
    new Request("http://localhost/__admin/destroy", { method: "POST" }),
  );
  const payload = (await destroyResp.json().catch(() => ({}))) as Record<string, unknown>;
  await registryRemove(c.env, runId);
  const headers = new Headers({ "Content-Type": "application/json" });
  const cookies = parseCookies(c.req.header("Cookie"));
  if (cookies[OC_RUN_COOKIE] === runId) {
    headers.append("Set-Cookie", clearOcRunCookieHeader());
  }
  return new Response(JSON.stringify({ runId, ...payload }), {
    status: destroyResp.status,
    headers,
  });
});

/**
 * Document entry for a run: proxy OpenCode HTML under /r/:runId/ (no 302 to /).
 * Router shim + HTML/JS rewrites keep SolidJS happy without --base-path.
 */
async function proxyRunDocument(env: Env, runId: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const stripped = new Request(new URL("/" + url.search, url.origin).toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
  return proxyToRun(env, runId, stripped, {
    setStickyCookie: true,
    rewriteHtml: true,
    rewriteJs: false,
  });
}

/** Load RunMeta from the run DO via __admin/status (no container start required for storage read). */
async function loadRunMeta(env: Env, runId: string): Promise<RunMeta | null> {
  try {
    const container = getContainer(env.OPENCODE_CONTAINER, runId);
    const statusResp = await container.fetch(new Request("http://localhost/__admin/status"));
    const status = (await statusResp.json().catch(() => null)) as { run?: RunMeta } | null;
    return status?.run ?? null;
  } catch {
    return null;
  }
}

/**
 * If the run has an auto-started session, 302 under /r/:runId/…/session/… so the
 * OpenCode SPA opens the chat immediately (shim strips only /r/:runId).
 */
async function maybeRedirectToSession(
  env: Env,
  runId: string,
  request: Request,
): Promise<Response | null> {
  const meta = await loadRunMeta(env, runId);
  const sessionId = meta?.sessionId?.trim();
  const directory = (
    meta?.directory ||
    (meta?.repo ? worktreeDirectory(meta.repo) : undefined)
  )?.trim();
  if (!directory || directory === "/home/dev") return null;
  const dest = sessionId
    ? `/r/${encodeURIComponent(runId)}${sessionDeepPath(directory, sessionId)}`
    : `/r/${encodeURIComponent(runId)}${projectDeepPath(directory)}`;
  // Preserve query string (rare) but stay under /r/
  const url = new URL(request.url);
  const location = dest + (url.search || "");
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Set-Cookie": ocRunCookieHeader(runId),
    },
  });
}

app.get("/r/:runId/__oc-shim.js", async (c) => {
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.text("Invalid run id", 400);
  return ocShimResponse(runId);
});

app.get("/r/:runId/", async (c) => {
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.text("Invalid run id", 400);
  const redirect = await maybeRedirectToSession(c.env, runId, c.req.raw);
  if (redirect) return redirect;
  return proxyRunDocument(c.env, runId, c.req.raw);
});

app.get("/r/:runId", async (c) => {
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.text("Invalid run id", 400);
  const redirect = await maybeRedirectToSession(c.env, runId, c.req.raw);
  if (redirect) return redirect;
  // Keep trailing slash URL as canonical for assets/relative resolution
  const dest = `/r/${runId}/`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: dest,
      "Set-Cookie": ocRunCookieHeader(runId),
    },
  });
});

// Per-run proxy for assets/API/deep paths: /r/:runId/assets/..., /r/:runId/global/..., etc.
app.all("/r/:runId/*", async (c) => {
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.text("Invalid run id", 400);

  const url = new URL(c.req.url);
  const prefix = `/r/${runId}`;
  let path = url.pathname.slice(prefix.length);
  if (!path.startsWith("/")) path = `/${path}`;

  // Worker-served shim (also matched by /* if dedicated route order differs)
  if (path === "/__oc-shim.js") {
    return ocShimResponse(runId);
  }

  // Document root under /r/:runId/ — session deep link or SPA HTML (never 302 to domain /)
  if (
    (c.req.method === "GET" || c.req.method === "HEAD") &&
    (path === "/" || path === "")
  ) {
    const redirect = await maybeRedirectToSession(c.env, runId, c.req.raw);
    if (redirect) return redirect;
    return proxyRunDocument(c.env, runId, c.req.raw);
  }

  // SPA deep links — serve index HTML so Solid can route
  // (shim strips /r/:runId; forwarding the deep path to OpenCode would often 404).
  // Supports:
  //   /${cn(dir)}/session/:id   (legacy session deep link)
  //   /${cn(dir)}/session       (project open / new session)
  //   /server/:key/session/:id  (OpenCode 1.18+ new-layout redirect target)
  if (
    (c.req.method === "GET" || c.req.method === "HEAD") &&
    (/^\/[^/]+\/session(?:\/[^/]+)?\/?$/.test(path) ||
      /^\/server\/[^/]+\/session\/[^/]+\/?$/.test(path))
  ) {
    return proxyRunDocument(c.env, runId, c.req.raw);
  }

  // Rebuild request with container-root path (strip /r/:runId)
  const stripped = new Request(new URL(path + url.search, url.origin).toString(), {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
    redirect: "manual",
  });

  return proxyToRun(c.env, runId, stripped, {
    setStickyCookie: true,
    rewriteHtml: true,
    rewriteJs: path.endsWith(".js"),
  });
});

app.use("/admin/*", cors());

app.get("/admin", (c) => c.html(getAdminHTML()));

// Admin helpers (Cloudflare Access only — no RUNNER_API_TOKEN).
// Browser UI uses these; harness-router uses /api/runs* with bearer.
app.all("/admin/api/:action", async (c) => {
  const action = c.req.param("action");
  try {
    if (action === "list") {
      const runs = await registryList(c.env);
      return c.json({ runs });
    }

    // Create / bootstrap a run (same path as POST /api/runs, without bearer).
    if (action === "create" || action === "bootstrap") {
      if (c.req.method !== "POST") return c.json({ error: "Method not allowed" }, 405);
      const body = (await c.req.json().catch(() => ({}))) as CreateRunBody;
      // Allow runId via query as well for convenience
      if (!body.runId && c.req.query("runId")) {
        body.runId = c.req.query("runId") || undefined;
      }
      return createRunResponse(c.env, c.req.url, body);
    }

    const runId = sanitizeRunId(c.req.query("runId") || "opencode-main");
    if (!runId) return c.json({ error: "Invalid runId" }, 400);
    const container = getContainer(c.env.OPENCODE_CONTAINER, runId);
    if (action === "status" || action === "config") {
      const resp = await container.fetch(new Request(`http://localhost/__admin/${action}`));
      if (action === "config") return resp;
      const status = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      const runMeta = (status.run || null) as RunMeta | null;
      const url = openCodeUiUrl(c.req.url, runId, {
        sessionId: runMeta?.sessionId,
        directory:
          runMeta?.directory ||
          (runMeta?.repo ? worktreeDirectory(runMeta.repo) : undefined),
      });
      return c.json({ ...status, openCodeUrl: url, url });
    }
    if (action === "start" || action === "git-token") {
      const bodyText = await c.req.text().catch(() => "");
      return container.fetch(
        new Request(`http://localhost/__admin/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyText || "{}",
        }),
      );
    }
    if (["stop", "restart", "refresh-capabilities"].includes(action)) {
      return container.fetch(new Request(`http://localhost/__admin/${action}`, { method: "POST" }));
    }
    if (action === "destroy") {
      if (c.req.method !== "POST" && c.req.method !== "DELETE") {
        return c.json({ error: "Method not allowed" }, 405);
      }
      const destroyResp = await container.fetch(
        new Request("http://localhost/__admin/destroy", { method: "POST" }),
      );
      const payload = (await destroyResp.json().catch(() => ({}))) as Record<string, unknown>;
      await registryRemove(c.env, runId);
      return new Response(JSON.stringify({ runId, ...payload }), {
        status: destroyResp.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return c.json({ error: "Unknown action" }, 404);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

/**
 * Sticky fallthrough: OpenCode UI loads /assets/*, /site.webmanifest, /session, etc.
 * at host root. If oc_run cookie is set, proxy those to the run container unchanged.
 * Reserved prefixes (/api, /admin, /r, /worker-health) are never fallthrough targets
 * here because they already have routes; this catch-all only sees unmatched paths.
 *
 * Bare "/" is special: never serve the API catalog or sticky OpenCode HTML there.
 * With oc_run → redirect into /r/:runId/; without → /admin. That stops the flip
 * between JSON listing and the last-opened UI when visiting the host root.
 */
app.all("*", async (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname;
  const cookies = parseCookies(c.req.header("Cookie"));
  const sticky = sanitizeRunId(cookies[OC_RUN_COOKIE] || "");

  if (path === "/" || path === "") {
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      if (sticky) {
        return c.redirect(`/r/${encodeURIComponent(sticky)}/${url.search}`, 302);
      }
      return c.redirect(`/admin${url.search}`, 302);
    }
    return c.json({ error: "Use /admin or /r/:runId/" }, 404);
  }

  const reserved =
    path.startsWith("/api/") ||
    path === "/api" ||
    path.startsWith("/admin") ||
    path.startsWith("/r/") ||
    path === "/r" ||
    path === "/worker-health" ||
    path.startsWith("/worker-health/");

  if (!reserved && sticky) {
    return proxyToRun(c.env, sticky, c.req.raw, {
      setStickyCookie: true,
      rewriteHtml: true,
    });
  }

  return c.json(
    {
      error: "Use per-run URLs",
      createRun: "POST /api/runs",
      listRuns: "GET /api/runs",
      getRun: "GET /api/runs/:runId",
      startRun: "POST /api/runs/:runId/start",
      stopRun: "POST /api/runs/:runId/stop",
      restartRun: "POST /api/runs/:runId/restart",
      refreshCapabilities: "POST /api/runs/:runId/refresh-capabilities",
      deleteRun: "DELETE /api/runs/:runId",
      openRun: "/r/:runId/",
      capabilities: "GET /api/capabilities",
      health: "GET /api/health",
      admin: "GET /admin",
      adminCreate: "POST /admin/api/create",
      adminList: "GET /admin/api/list",
    },
    404,
  );
});

export default {
  fetch: app.fetch,
};
