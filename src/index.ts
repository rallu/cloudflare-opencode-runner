import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getAdminHTML } from "./admin-ui";

interface Env {
  OPENCODE_CONTAINER: DurableObjectNamespace<OpenCodeContainer>;
  CAPABILITIES: DurableObjectNamespace<CapabilitiesCache>;
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
  status: "starting" | "ready" | "destroyed" | "error";
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
  entrypoint: ["/home/dev/startup.sh"],
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

export class OpenCodeContainer extends Container<Env> {
  defaultPort = 4096;
  // Idle sleep; hard TTL is enforced via DO alarm (~4h)
  sleepAfter = "4h";
  enableInternet = true;
  // Required: empty entrypoint from the Containers runtime would clear the image ENTRYPOINT
  // and the instance exits immediately with "container just exited".
  entrypoint = ["/home/dev/startup.sh"];

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

  override async alarm(): Promise<void> {
    const meta = await this.loadMeta();
    console.log("Run lifetime alarm fired", meta?.runId);
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
    if (meta) {
      meta.status = "destroyed";
      await this.saveMeta(meta);
    }
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

  private async doRefreshCapabilities(): Promise<Response> {
    const meta = await this.applyEnvFromMeta();
    if (!meta?.runId) return json({ error: "No run meta" }, 400);
    await this.startAndWaitForPorts({
      ports: [this.defaultPort],
      cancellationOptions: { ...START_WAIT },
      startOptions: { ...CONTAINER_START },
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

    this.envVars = this.buildEnvVars(meta);

    try {
      await this.startAndWaitForPorts({
        ports: [this.defaultPort],
        cancellationOptions: { ...START_WAIT },
      });
      meta.status = "ready";
      await this.saveMeta(meta);

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
      return json({ success: false, runId, status: meta.status, error: meta.error }, 500);
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
    await this.startAndWaitForPorts({
      ports: [this.defaultPort],
      cancellationOptions: { ...START_WAIT },
      startOptions: { ...CONTAINER_START },
    });
    if (meta) {
      meta.status = "ready";
      await this.saveMeta(meta);
    }
    return json({ success: true, message: "Container started successfully" });
  }

  private async doStop(): Promise<Response> {
    await this.stop();
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
    }
    await this.ctx.storage.deleteAlarm();
    return json({ success: true, message: "Container destroyed" });
  }

  private async doRestart(): Promise<Response> {
    try {
      await this.stop();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await this.applyEnvFromMeta();
    await this.startAndWaitForPorts({
      ports: [this.defaultPort],
      cancellationOptions: { ...START_WAIT },
      startOptions: { ...CONTAINER_START },
    });
    return json({ success: true, message: "Container restarted successfully" });
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

// Admin helpers still target an explicit run via ?runId= or default demo id
app.all("/admin/api/:action", async (c) => {
  const runId = sanitizeRunId(c.req.query("runId") || "opencode-main");
  if (!runId) return c.json({ error: "Invalid runId" }, 400);
  const action = c.req.param("action");
  const container = getContainer(c.env.OPENCODE_CONTAINER, runId);
  try {
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
      openRun: "/r/:runId/",
      capabilities: "GET /api/capabilities",
      health: "GET /api/health",
    },
    404,
  );
});

export default {
  fetch: app.fetch,
};
