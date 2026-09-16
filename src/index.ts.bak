import { Container, getContainer } from "@cloudflare/containers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getAdminHTML } from "./admin-ui";

interface Env {
  OPENCODE_CONTAINER: DurableObjectNamespace<OpenCodeContainer>;
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

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const START_WAIT = {
  portReadyTimeoutMS: 180_000,
  instanceGetTimeoutMS: 60_000,
} as const;

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

export class OpenCodeContainer extends Container<Env> {
  defaultPort = 4096;
  // Idle sleep; hard TTL is enforced via DO alarm (~4h)
  sleepAfter = "4h";
  enableInternet = true;

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
    // startup.sh clones URLs; branch is handled after clone if provided via RUN_BRANCH
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
      return json({
        success: true,
        runId,
        status: meta.status,
        createdAt,
        expiresAt,
        expiresAtIso: new Date(expiresAt).toISOString(),
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
  const method = c.req.method;
  try {
    if (action === "status" || action === "config") {
      return container.fetch(new Request(`http://localhost/__admin/${action}`));
    }
    if (["start", "stop", "restart", "destroy"].includes(action)) {
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
    },
    404,
  );
});

export default {
  fetch: app.fetch,
};
