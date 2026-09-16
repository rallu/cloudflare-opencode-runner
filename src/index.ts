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
  /** Max lifetime before hard destroy (ms). Default 4h. */
  MAX_RUN_LIFETIME_MS?: string;
}

type RunMeta = {
  runId: string;
  repo?: string;
  branch?: string;
  /** Post-clone shell commands (first repo). Also passed as SETUP_COMMANDS env. */
  setup?: string[];
  createdAt: number;
  expiresAt: number;
  status: "starting" | "ready" | "error" | "stopped" | "destroyed";
  error?: string;
  /** Auto-prompt session created after bootstrap (if prompt was requested). */
  sessionId?: string;
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

  const models: RunnerCapabilities["models"] = [];
  const providerList = (provider?.all || configProviders?.providers || []) as Array<Record<string, unknown>>;
  for (const p of providerList) {
    const providerID = String(p.id || p.providerID || p.name || "");
    const modelMap = (p.models || {}) as Record<string, { name?: string } | string>;
    if (modelMap && typeof modelMap === "object" && !Array.isArray(modelMap)) {
      for (const [modelId, meta] of Object.entries(modelMap)) {
        const name = typeof meta === "string" ? meta : meta?.name;
        models.push({
          id: providerID ? `${providerID}/${modelId}` : modelId,
          providerID: providerID || undefined,
          name,
        });
      }
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
    providers: providerList,
    models,
    agents: Array.isArray(parts.agents) ? parts.agents : [],
    commands: Array.isArray(parts.commands) ? parts.commands : [],
    raw: {
      health: parts.health,
      config: parts.config,
      configProviders: parts.configProviders,
      provider: parts.provider,
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

export class OpenCodeRunner extends Container<Env> {
  defaultPort = 4096;
  // Idle sleep; hard TTL is enforced via DO alarm (~4h)
  sleepAfter = "4h";
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
    let gitRepos = repo || this.env.GIT_REPOS || "";
    const setupCmds = (meta?.setup || []).map((c) => String(c).trim()).filter(Boolean);
    return {
      OPENCODE_PERMISSION: '{"edit":"allow","bash":"allow","write":"allow"}',
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_API_KEY: this.env.OPENCODE_API_KEY || "",
      GIT_REPOS: gitRepos,
      GIT_TOKEN: this.env.GIT_TOKEN || "",
      RUN_ID: meta?.runId || "",
      RUN_BRANCH: branch || "",
      // Newline-separated; startup.sh also accepts ||| separators.
      SETUP_COMMANDS: setupCmds.join("\n"),
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
   * Only hard-destroy when our per-run TTL has elapsed; otherwise defer to super.
   */
  override async alarm(alarmProps?: { isRetry?: boolean; retryCount?: number }): Promise<void> {
    const meta = await this.loadMeta();
    const now = Date.now();
    if (meta?.expiresAt && now >= meta.expiresAt) {
      console.log("Run lifetime TTL alarm fired", meta.runId);
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
          return this.doStart();
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

    await Promise.all([
      settle("health", "/global/health"),
      settle("config", "/config"),
      settle("configProviders", "/config/providers"),
      settle("provider", "/provider"),
      settle("agents", "/agent"),
      settle("commands", "/command"),
    ]);

    const caps = normalizeCapabilities(runId, parts);
    if (!parts.health && !parts.provider && !parts.config) {
      caps.available = false;
      caps.error = "OpenCode did not return health/config/provider after start";
    }

    try {
      await capabilitiesStub(this.env).fetch(
        new Request("http://capabilities/store", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(caps),
        }),
      );
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
        if (text) return text.slice(0, 32_000);
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

  private async autoCreateSessionAndPrompt(opts: {
    repo?: string;
    prompt: string;
    title?: string;
    model?: { providerID: string; modelID: string };
    agent?: string;
  }): Promise<PromptResult> {
    const directory = worktreeDirectory(opts.repo);
    const title =
      (opts.title && opts.title.trim()) ||
      opts.prompt.trim().slice(0, 80) ||
      "Auto session";
    const model = opts.model?.providerID && opts.model?.modelID
      ? opts.model
      : { ...DEFAULT_PROMPT_MODEL };

    try {
      const sessionResp = await this.containerFetch(
        new Request(
          `http://127.0.0.1:${this.defaultPort}/session?directory=${encodeURIComponent(directory)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title }),
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

      const promptBody: Record<string, unknown> = {
        parts: [{ type: "text", text: opts.prompt }],
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

  private async doBootstrap(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      runId?: string;
      repo?: string;
      branch?: string;
      maxLifetimeMs?: number;
      prompt?: string;
      title?: string;
      model?: { providerID: string; modelID: string };
      agent?: string;
      setup?: string[];
    };

    const runId = sanitizeRunId(body.runId || "");
    if (!runId) return json({ error: "Invalid runId" }, 400);

    const setup = Array.isArray(body.setup)
      ? body.setup.map((c) => String(c)).filter((c) => c.trim())
      : undefined;

    const maxLifetimeMs = Math.min(
      Math.max(Number(body.maxLifetimeMs || this.env.MAX_RUN_LIFETIME_MS || FOUR_HOURS_MS), 60_000),
      FOUR_HOURS_MS,
    );
    const createdAt = Date.now();
    const expiresAt = createdAt + maxLifetimeMs;

    const meta: RunMeta = {
      runId,
      repo: body.repo,
      branch: body.branch,
      setup,
      createdAt,
      expiresAt,
      status: "starting",
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
        meta.error = "OpenCode process exited; crash keep-alive is serving health";
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

      let prompt: PromptResult | undefined;
      const promptText = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (promptText) {
        prompt = await this.autoCreateSessionAndPrompt({
          repo: body.repo,
          prompt: promptText,
          title: body.title,
          model: body.model,
          agent: body.agent,
        });
        if (prompt.sessionId) {
          meta.sessionId = prompt.sessionId;
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
        capabilities,
        ...(prompt
          ? {
              prompt,
              sessionId: prompt.sessionId,
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
      run: meta,
    });
  }

  private async doStart(): Promise<Response> {
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
        hasGitToken: !!this.env.GIT_TOKEN,
        auth: "cloudflare-access",
      },
      containerConfig: {
        defaultPort: this.defaultPort,
        sleepAfter: this.sleepAfter,
        enableInternet: this.enableInternet,
        maxLifetimeMs: Number(this.env.MAX_RUN_LIFETIME_MS || FOUR_HOURS_MS),
      },
      run: meta,
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
  maxLifetimeMs?: number;
  prompt?: string;
  title?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  setup?: string[];
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
        prompt: body.prompt,
        title: body.title,
        model: body.model,
        agent: body.agent,
        setup: body.setup,
      }),
    }),
  );

  const payload = (await bootstrap.json().catch(() => ({}))) as Record<string, unknown>;
  const url = runUrl(requestUrl, runId);

  if (!bootstrap.ok) {
    return new Response(JSON.stringify({ ...payload, url, openCodeUrl: url }), {
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
        health: `${url}global/health`,
        openapi: `${url}doc`,
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
  return container.fetch(new Request("http://localhost/__admin/start", { method: "POST" }));
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

app.get("/api/runs/:runId", async (c) => {
  if (!requireRunnerAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.json({ error: "Invalid runId" }, 400);

  const container = getContainer(c.env.OPENCODE_CONTAINER, runId);
  const statusResp = await container.fetch(new Request("http://localhost/__admin/status"));
  const status = (await statusResp.json().catch(() => ({}))) as Record<string, unknown>;
  const url = runUrl(c.req.url, runId);
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

app.get("/r/:runId/__oc-shim.js", async (c) => {
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.text("Invalid run id", 400);
  return ocShimResponse(runId);
});

app.get("/r/:runId/", async (c) => {
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.text("Invalid run id", 400);
  return proxyRunDocument(c.env, runId, c.req.raw);
});

app.get("/r/:runId", async (c) => {
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.text("Invalid run id", 400);
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

  // Document root under /r/:runId/ — proxy SPA HTML (do NOT 302 to domain root)
  if (
    (c.req.method === "GET" || c.req.method === "HEAD") &&
    (path === "/" || path === "")
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
      return container.fetch(new Request(`http://localhost/__admin/${action}`));
    }
    if (["start", "stop", "restart", "refresh-capabilities"].includes(action)) {
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
 */
app.all("*", async (c) => {
  const path = new URL(c.req.url).pathname;
  const reserved =
    path.startsWith("/api/") ||
    path === "/api" ||
    path.startsWith("/admin") ||
    path.startsWith("/r/") ||
    path === "/r" ||
    path === "/worker-health" ||
    path.startsWith("/worker-health/");

  if (!reserved) {
    const cookies = parseCookies(c.req.header("Cookie"));
    const sticky = sanitizeRunId(cookies[OC_RUN_COOKIE] || "");
    if (sticky) {
      return proxyToRun(c.env, sticky, c.req.raw, {
        setStickyCookie: true,
        rewriteHtml: true,
      });
    }
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
