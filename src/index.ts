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
  createdAt: number;
  expiresAt: number;
  status: "starting" | "ready" | "error" | "stopped" | "destroyed";
  error?: string;
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
  portReadyTimeoutMS: 180_000,
  instanceGetTimeoutMS: 60_000,
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
    return {
      OPENCODE_PERMISSION: '{"edit":"allow","bash":"allow","write":"allow"}',
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_API_KEY: this.env.OPENCODE_API_KEY || "",
      GIT_REPOS: gitRepos,
      GIT_TOKEN: this.env.GIT_TOKEN || "",
      RUN_ID: meta?.runId || "",
      RUN_BRANCH: branch || "",
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

  private async doBootstrap(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      runId?: string;
      repo?: string;
      branch?: string;
      maxLifetimeMs?: number;
    };

    const runId = sanitizeRunId(body.runId || "");
    if (!runId) return json({ error: "Invalid runId" }, 400);

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

      return json({
        success: true,
        runId,
        status: meta.status,
        createdAt,
        expiresAt,
        expiresAtIso: new Date(expiresAt).toISOString(),
        capabilities,
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

/** Create / ensure a per-run OpenCode instance. Returns a UI link for harness-router. */
app.post("/api/runs", async (c) => {
  if (!requireRunnerAuth(c)) return c.json({ error: "Unauthorized" }, 401);

  const body = (await c.req.json().catch(() => ({}))) as {
    runId?: string;
    repo?: string;
    branch?: string;
    maxLifetimeMs?: number;
  };

  const runId = sanitizeRunId(body.runId || crypto.randomUUID());
  if (!runId) return c.json({ error: "Invalid runId" }, 400);

  const container = getContainer(c.env.OPENCODE_CONTAINER, runId);
  const bootstrap = await container.fetch(
    new Request("http://localhost/__admin/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        repo: body.repo,
        branch: body.branch,
        maxLifetimeMs: body.maxLifetimeMs,
      }),
    }),
  );

  const payload = (await bootstrap.json().catch(() => ({}))) as Record<string, unknown>;
  const url = runUrl(c.req.url, runId);

  if (!bootstrap.ok) {
    return new Response(JSON.stringify({ ...payload, url, openCodeUrl: url }), {
      status: bootstrap.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return c.json(
    {
      ...payload,
      url,
      openCodeUrl: url,
      links: {
        ui: url,
        health: `${url}global/health`,
        openapi: `${url}doc`,
        capabilities: new URL("/api/capabilities", c.req.url).toString(),
      },
    },
    201,
  );
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
  return new Response(JSON.stringify({ runId, ...payload }), {
    status: destroyResp.status,
    headers: { "Content-Type": "application/json" },
  });
});

// Per-run OpenCode UI + API: /r/:runId/...
app.all("/r/:runId/*", async (c) => {
  const runId = sanitizeRunId(c.req.param("runId"));
  if (!runId) return c.text("Invalid run id", 400);

  const url = new URL(c.req.url);
  const prefix = `/r/${runId}`;
  let path = url.pathname.slice(prefix.length);
  if (!path.startsWith("/")) path = `/${path}`;
  if (path === "/") path = "/";

  const target = new URL(path + url.search, "http://container");
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");

  const container = getContainer(c.env.OPENCODE_CONTAINER, runId);
  return container.fetch(
    new Request(target.toString(), {
      method: c.req.method,
      headers,
      body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
      redirect: "manual",
    }),
  );
});

// Convenience: /r/:runId → /r/:runId/
app.get("/r/:runId", (c) => {
  const runId = c.req.param("runId");
  return c.redirect(`/r/${encodeURIComponent(runId)}/`, 302);
});

app.use("/admin/*", cors());

app.get("/admin", (c) => c.html(getAdminHTML()));

// Admin helpers: list from registry (no bearer); actions take ?runId=
app.all("/admin/api/:action", async (c) => {
  const action = c.req.param("action");
  try {
    if (action === "list") {
      const runs = await registryList(c.env);
      return c.json({ runs });
    }
    const runId = sanitizeRunId(c.req.query("runId") || "opencode-main");
    if (!runId) return c.json({ error: "Invalid runId" }, 400);
    const container = getContainer(c.env.OPENCODE_CONTAINER, runId);
    if (action === "status" || action === "config") {
      return container.fetch(new Request(`http://localhost/__admin/${action}`));
    }
    if (["start", "stop", "restart", "destroy", "refresh-capabilities"].includes(action)) {
      return container.fetch(new Request(`http://localhost/__admin/${action}`, { method: "POST" }));
    }
    return c.json({ error: "Unknown action" }, 404);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

// No shared catch-all instance: automation must use /api/runs + /r/:runId
app.all("*", (c) => {
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
    },
    404,
  );
});

export default {
  fetch: app.fetch,
};
