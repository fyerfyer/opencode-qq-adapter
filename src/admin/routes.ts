import { timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Logger } from "pino";
import { ZodError, z } from "zod";
import type { AppConfig } from "../config/schema.js";
import { groupSchema, policySchema, projectSchema, userSchema } from "../config/schema.js";
import type { AdminSessionRecord } from "../domain/admin.js";
import { AdminConfigError } from "./config-editor.js";
import { PromptError } from "./prompts.js";
import { AdminError, type AdminService } from "./service.js";

const SESSION_COOKIE = "opencode_qq_admin";

interface AdminVariables {
  session: AdminSessionRecord;
}

type AdminEnv = { Variables: AdminVariables };
type AdminContext = Context<AdminEnv>;

export interface AdminRoutesOptions {
  service: AdminService;
  config: AppConfig;
  version: string;
  logger: Logger;
}

/**
 * `/admin/api` Hono app. Authentication, CSRF and loopback checks live here so
 * every route (including future plugin pages) shares one boundary.
 */
export function createAdminApi(options: AdminRoutesOptions): Hono<AdminEnv> {
  const { service, config, version, logger } = options;
  const api = new Hono<AdminEnv>();

  api.use("*", async (context, next) => {
    if (!config.admin.enabled) {
      return context.json({ error: "admin_disabled", message: "Admin WebUI 已禁用。" }, 404);
    }
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Frame-Options", "DENY");
    context.header("Referrer-Policy", "no-referrer");
    const meta = clientMeta(context, config);
    if (!config.admin.allow_remote && !isLoopback(meta.ip)) {
      return context.json(
        { error: "forbidden_remote", message: "Admin WebUI 只允许本机访问。" },
        403,
      );
    }
    await next();
  });

  api.get("/auth/session", (context) => {
    const token = readSessionToken(context);
    const session = service.auth.session(token);
    if (session === null) {
      return context.json({ authenticated: false }, 401);
    }
    const account = service.auth.account();
    return context.json({
      authenticated: true,
      username: session.username,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      mustChangePassword: account?.mustChangePassword ?? false,
    });
  });

  api.post("/auth/login", async (context) => {
    requireSameOrigin(context);
    const body = await readJson(context, z.object({ password: z.string().min(1).max(1024) }));
    const meta = clientMeta(context, config);
    const result = await service.login(body.password, meta);
    if (!result.ok) {
      if (result.reason === "rate_limited") {
        const seconds = Math.ceil((result.retryAfterMs ?? 0) / 1000);
        context.header("Retry-After", String(seconds));
        return context.json(
          { error: "rate_limited", message: `登录尝试过多，请 ${seconds} 秒后再试。` },
          429,
        );
      }
      return context.json({ error: "invalid_credentials", message: "密码不正确。" }, 401);
    }
    setSessionCookie(context, result.token, config, result.expiresAt);
    return context.json({
      authenticated: true,
      username: result.username,
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt,
      mustChangePassword: result.mustChangePassword,
    });
  });

  api.post("/auth/logout", (context) => {
    const session = requireSession(context, service);
    requireCsrf(context, session);
    service.logout(readSessionToken(context));
    clearSessionCookie(context, config);
    return context.json({ ok: true });
  });

  api.use("*", async (context, next) => {
    const session = requireSession(context, service);
    if (!isSafeMethod(context.req.method)) requireCsrf(context, session);
    context.set("session", session);
    await next();
  });

  api.post("/auth/password", async (context) => {
    const body = await readJson(
      context,
      z.object({
        currentPassword: z.string().min(1).max(1024),
        newPassword: z.string().min(10).max(1024),
      }),
    );
    const result = await service.changePassword(
      body.currentPassword,
      body.newPassword,
      readSessionToken(context) ?? "",
      clientMeta(context, config),
    );
    return context.json(result);
  });

  api.get("/meta", (context) =>
    context.json({
      version,
      configPath: service.configPath,
      promptRoot: service.prompts.root,
      admin: {
        allowRemote: config.admin.allow_remote,
        sessionHours: config.admin.session_hours,
      },
      features: config.features,
      defaultProject: config.default_project,
      plugins: service.plugins(),
    }),
  );

  api.get("/overview", async (context) => context.json(await service.overview()));

  api.get("/access", async (context) => context.json(await service.access()));

  api.put("/users/:qq", async (context) => {
    const qq = validateQq(context.req.param("qq"));
    const user = await readJson(context, userSchema);
    const result = await service.upsertUser(qq, user, configHash(context));
    return context.json(result);
  });
  api.delete("/users/:qq", async (context) => {
    const qq = validateQq(context.req.param("qq"));
    const result = await service.deleteUser(qq, configHash(context));
    return context.json(result);
  });

  api.put("/groups/:id", async (context) => {
    const id = validateNumericId(context.req.param("id"), "group");
    const group = await readJson(context, groupSchema);
    const result = await service.upsertGroup(id, group, configHash(context));
    return context.json(result);
  });
  api.delete("/groups/:id", async (context) => {
    const id = validateNumericId(context.req.param("id"), "group");
    const result = await service.deleteGroup(id, configHash(context));
    return context.json(result);
  });

  api.put("/projects/:id", async (context) => {
    const id = validateId(context.req.param("id"), "project");
    const project = await readJson(context, projectSchema);
    const result = await service.upsertProject(id, project, configHash(context));
    return context.json(result);
  });
  api.delete("/projects/:id", async (context) => {
    const id = validateId(context.req.param("id"), "project");
    const result = await service.deleteProject(id, configHash(context));
    return context.json(result);
  });
  api.get("/projects/:id/sessions", async (context) => {
    const id = validateId(context.req.param("id"), "project");
    return context.json({ sessions: await service.projectSessions(id) });
  });
  api.delete("/projects/:id/sessions/:sessionId", async (context) => {
    const id = validateId(context.req.param("id"), "project");
    const sessionId = context.req.param("sessionId");
    await service.deleteProjectSession(id, sessionId);
    return context.json({ ok: true });
  });

  api.put("/policies/:name", async (context) => {
    const name = validateId(context.req.param("name"), "policy");
    const policy = await readJson(context, policySchema);
    const result = await service.upsertPolicy(name, policy, configHash(context));
    return context.json(result);
  });
  api.delete("/policies/:name", async (context) => {
    const name = validateId(context.req.param("name"), "policy");
    const result = await service.deletePolicy(name, configHash(context));
    return context.json(result);
  });

  api.put("/settings/default-project", async (context) => {
    const body = await readJson(context, z.object({ projectId: z.string().min(1).nullable() }));
    const result = await service.setDefaultProject(body.projectId, configHash(context));
    return context.json(result);
  });

  api.get("/models", async (context) => {
    const projectId = context.req.query("projectId");
    return context.json({ models: await service.conversationModels(projectId) });
  });

  api.get("/agents", async (context) => {
    const projectId = context.req.query("projectId");
    return context.json({ agents: await service.conversationAgents(projectId) });
  });

  api.get("/conversations", async (context) =>
    context.json({ conversations: await service.conversations() }),
  );
  api.post("/conversations/:chatKey/unbind", (context) => {
    service.unbindConversation(decodeURIComponent(context.req.param("chatKey")));
    return context.json({ ok: true });
  });
  api.post("/conversations/:chatKey/stop", async (context) =>
    context.json(await service.stopConversation(decodeURIComponent(context.req.param("chatKey")))),
  );
  api.patch("/conversations/:chatKey/preferences", async (context) => {
    const chatKey = decodeURIComponent(context.req.param("chatKey"));
    const body = await readJson(
      context,
      z
        .object({
          agent: z.string().min(1).max(200).optional(),
          model: z.string().min(1).max(200).optional(),
        })
        .strict()
        .refine((value) => value.agent !== undefined || value.model !== undefined, {
          message: "agent 或 model 至少提供一个。",
        }),
    );
    await service.setConversationPreferences(chatKey, {
      ...(body.agent !== undefined ? { agent: body.agent } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
    });
    return context.json({ ok: true });
  });

  api.post("/conversations/:chatKey/switch", async (context) => {
    const body = await readJson(context, z.object({ sessionId: z.string().min(1) }));
    await service.switchConversationSession(
      decodeURIComponent(context.req.param("chatKey")),
      body.sessionId,
    );
    return context.json({ ok: true });
  });

  api.get("/config", async (context) => context.json(await service.readConfig()));
  api.put("/config", async (context) => {
    const body = await readJson(
      context,
      z.object({
        content: z.string().max(2 * 1024 * 1024),
        expectedHash: z.string().optional(),
      }),
    );
    return context.json(await service.saveConfig(body.content, body.expectedHash));
  });
  api.post("/config/reload", async (context) => context.json(await service.reloadConfig()));

  api.get("/prompts", async (context) => context.json(await service.promptsList()));
  api.get("/prompts/:name", async (context) =>
    context.json(await service.readPrompt(context.req.param("name"))),
  );
  api.put("/prompts/:name", async (context) => {
    const body = await readJson(
      context,
      z.object({
        content: z.string().max(512 * 1024),
        override: z.boolean().optional(),
      }),
    );
    return context.json(
      await service.writePrompt(context.req.param("name"), body.content, {
        ...(body.override !== undefined ? { override: body.override } : {}),
      }),
    );
  });
  api.get("/prompts/:name/backups", async (context) =>
    context.json({ backups: await service.promptBackups(context.req.param("name")) }),
  );
  api.get("/prompts/:name/backups/:backup", async (context) =>
    context.json({
      content: await service.readPromptBackup(
        context.req.param("name"),
        context.req.param("backup"),
      ),
    }),
  );
  api.post("/prompts/:name/restore", async (context) => {
    const body = await readJson(
      context,
      z.object({
        backup: z.string().min(1),
        override: z.boolean().optional(),
      }),
    );
    return context.json(
      await service.restorePromptBackup(context.req.param("name"), body.backup, {
        ...(body.override !== undefined ? { override: body.override } : {}),
      }),
    );
  });

  api.get("/audit", (context) => {
    const limit = parseLimit(context.req.query("limit"), 200, 500);
    return context.json({ entries: service.audit(limit) });
  });

  api.get("/usage", (context) => {
    const day = context.req.query("day") ?? dayKey();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new AdminError(400, "invalid_day", "日期格式必须是 YYYY-MM-DD。");
    }
    const rows = service.usage(day);
    return context.json({ day, rows, total: sumUsage(rows) });
  });

  api.get("/plugins", (context) => context.json(service.plugins()));

  api.get("/plugins/:id/options", async (context) => {
    const id = validateId(context.req.param("id"), "plugin");
    return context.json(await service.pluginOptions(id));
  });

  api.put("/plugins/:id/options", async (context) => {
    const id = validateId(context.req.param("id"), "plugin");
    const body = await readJson(
      context,
      z.object({
        options: z.record(z.string(), z.unknown()),
        expectedHash: z.string().optional(),
      }),
    );
    return context.json(
      await service.savePluginOptions(id, body.options, body.expectedHash ?? configHash(context)),
    );
  });

  api.put("/plugins/:id/enabled", async (context) => {
    const id = validateId(context.req.param("id"), "plugin");
    const body = await readJson(
      context,
      z.object({
        enabled: z.boolean(),
        expectedHash: z.string().optional(),
      }),
    );
    return context.json(
      await service.setPluginEnabled(id, body.enabled, body.expectedHash ?? configHash(context)),
    );
  });

  api.get("/plugins/:id/ui", async (context) => {
    const id = validateId(context.req.param("id"), "plugin");
    return context.json(service.pluginUiPage(id));
  });

  api.get("/plugins/:id/ui/:pageId", async (context) => {
    const id = validateId(context.req.param("id"), "plugin");
    return context.json(service.pluginUiPage(id, context.req.param("pageId")));
  });

  api.post(
    "/plugins/install/preview",
    bodyLimit({
      maxSize: 24 * 1024 * 1024,
      onError: () => {
        throw new AdminError(413, "plugin_archive_too_large", "插件包不能超过 20 MiB。");
      },
    }),
    async (context) => {
      const body = await context.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) {
        throw new AdminError(400, "missing_file", "请上传 ZIP 插件包。");
      }
      return context.json(await service.previewPluginUpload(file));
    },
  );

  api.post("/plugins/install", async (context) => {
    const body = await readJson(
      context,
      z.object({
        uploadId: z.string().uuid(),
        enable: z.boolean().default(true),
        expectedHash: z.string().optional(),
      }),
    );
    return context.json(
      await service.installPluginUpload(
        body.uploadId,
        body.enable,
        body.expectedHash ?? configHash(context),
      ),
    );
  });

  api.post("/plugins/local/preview", async (context) => {
    const body = await readJson(
      context,
      z.object({
        path: z.string().min(1).max(2000),
      }),
    );
    return context.json(await service.previewLocalPlugin(body.path));
  });

  api.post("/plugins/local/install", async (context) => {
    const body = await readJson(
      context,
      z.object({
        path: z.string().min(1).max(2000),
        enable: z.boolean().default(true),
        expectedHash: z.string().optional(),
      }),
    );
    return context.json(
      await service.installLocalPlugin(
        body.path,
        body.enable,
        body.expectedHash ?? configHash(context),
      ),
    );
  });

  api.post("/plugins/:id/reload", async (context) => {
    const id = validateId(context.req.param("id"), "plugin");
    return context.json(await service.reloadPlugin(id));
  });

  api.post("/plugins/:id/rollback", async (context) => {
    const id = validateId(context.req.param("id"), "plugin");
    return context.json(await service.rollbackPlugin(id));
  });

  api.post("/plugins/:id/uninstall", async (context) => {
    const id = validateId(context.req.param("id"), "plugin");
    const body = await readJson(
      context,
      z.object({
        deleteData: z.boolean().default(false),
        expectedHash: z.string().optional(),
      }),
    );
    return context.json(
      await service.uninstallPlugin(id, body.deleteData, body.expectedHash ?? configHash(context)),
    );
  });

  api.all("/plugins/:id/*", async (context) => {
    const id = validateId(context.req.param("id"), "plugin");
    const prefix = `/admin/api/plugins/${id}`;
    const path = context.req.path.startsWith(prefix)
      ? context.req.path.slice(prefix.length) || "/"
      : "/";
    const session = context.get("session");
    const result = await service.dispatchPluginAdmin(id, context.req.raw, path, {
      username: session.username,
    });
    if (result instanceof Response) {
      const headers = new Headers(result.headers);
      if (!headers.has("cache-control")) headers.set("cache-control", "private, no-store");
      headers.set("x-content-type-options", "nosniff");
      const contentType = headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        throw new AdminError(415, "plugin_html_forbidden", "插件管理接口不能返回 HTML。");
      }
      return new Response(result.body, {
        status: result.status,
        statusText: result.statusText,
        headers,
      });
    }
    return context.json(result);
  });

  api.notFound((context) => context.json({ error: "not_found" }, 404));
  api.onError((error, context) => {
    if (error instanceof AdminError) {
      return context.json(
        { error: error.code, message: error.message, details: error.details },
        error.status,
      );
    }
    if (error instanceof AdminConfigError) {
      return context.json(
        { error: error.code, message: error.message, details: error.details },
        error.status,
      );
    }
    if (error instanceof PromptError) {
      return context.json({ error: error.code, message: error.message }, error.status);
    }
    if (error instanceof ZodError) {
      return context.json(
        {
          error: "invalid_request",
          message: "请求参数不合法。",
          details: error.issues.map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          ),
        },
        400,
      );
    }
    logger.error({ err: error, path: context.req.path }, "Admin API request failed");
    return context.json({ error: "internal_error", message: "管理接口发生内部错误。" }, 500);
  });

  return api;
}

function requireSession(context: AdminContext, service: AdminService): AdminSessionRecord {
  const session = service.auth.session(readSessionToken(context));
  if (session === null) throw new AdminError(401, "unauthorized", "请先登录。");
  return session;
}

function requireCsrf(context: AdminContext, session: AdminSessionRecord): void {
  requireSameOrigin(context);
  const provided = context.req.header("x-csrf-token") ?? "";
  if (!constantTimeEqual(provided, session.csrfToken)) {
    throw new AdminError(403, "csrf_failed", "CSRF 校验失败，请刷新页面后重试。");
  }
}

function requireSameOrigin(context: AdminContext): void {
  const origin = context.req.header("origin");
  if (origin === undefined || origin.length === 0) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new AdminError(403, "origin_rejected", "Origin 不合法。");
  }
  const host = context.req.header("x-forwarded-host") ?? context.req.header("host");
  if (host === undefined || parsed.host !== host) {
    throw new AdminError(403, "origin_rejected", "拒绝跨站请求。");
  }
}

function readSessionToken(context: AdminContext): string | undefined {
  return getCookie(context, SESSION_COOKIE);
}

function setSessionCookie(
  context: AdminContext,
  token: string,
  config: AppConfig,
  expiresAt: number,
): void {
  const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/admin",
    maxAge,
    ...(isSecureRequest(context, config) ? { secure: true } : {}),
  });
}

function clearSessionCookie(context: AdminContext, config: AppConfig): void {
  deleteCookie(context, SESSION_COOKIE, {
    path: "/admin",
    ...(isSecureRequest(context, config) ? { secure: true } : {}),
  });
}

function clientMeta(
  context: AdminContext,
  config: AppConfig,
): { ip: string | null; userAgent: string | null } {
  let ip: string | null = null;
  if (config.admin.trust_proxy) {
    const forwarded = context.req.header("x-forwarded-for");
    if (forwarded !== undefined) ip = forwarded.split(",")[0]?.trim() ?? null;
  }
  if (ip === null) {
    try {
      ip = getConnInfo(context).remote.address ?? null;
    } catch {
      ip = null;
    }
  }
  return { ip, userAgent: context.req.header("user-agent") ?? null };
}

function isSecureRequest(context: AdminContext, config: AppConfig): boolean {
  try {
    if (new URL(context.req.url).protocol === "https:") return true;
  } catch {
    // Fall through to proxy headers.
  }
  return config.admin.trust_proxy && context.req.header("x-forwarded-proto") === "https";
}

async function readJson<T>(context: AdminContext, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new AdminError(400, "invalid_json", "请求体必须是 JSON。");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AdminError(
      400,
      "invalid_request",
      "请求参数不合法。",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function configHash(context: AdminContext): string | undefined {
  const value = context.req.header("x-config-hash");
  return value === undefined || value.length === 0 ? undefined : value;
}

function validateQq(value: string): string {
  if (!/^\d{5,12}$/.test(value)) {
    throw new AdminError(400, "invalid_qq", "QQ 号必须是 5–12 位数字。");
  }
  return value;
}

function validateNumericId(value: string, label: string): string {
  if (!/^\d+$/.test(value)) {
    throw new AdminError(400, "invalid_id", `${label} ID 必须是数字。`);
  }
  return value;
}

function validateId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new AdminError(400, "invalid_id", `${label} ID 不合法。`);
  }
  return value;
}

function parseLimit(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new AdminError(400, "invalid_limit", `limit 必须在 1–${max} 之间。`);
  }
  return parsed;
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function isLoopback(ip: string | null): boolean {
  // If the adapter cannot expose a peer address, keep the loopback-only default
  // rather than accidentally allowing a remote request.
  if (ip === null) return false;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip.startsWith("127.") ||
    ip.startsWith("::ffff:127.")
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function dayKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sumUsage(rows: unknown[]): {
  prompts: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
} {
  let prompts = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const value = row as Record<string, unknown>;
    prompts += numberValue(value.prompts);
    inputTokens += numberValue(value.inputTokens);
    outputTokens += numberValue(value.outputTokens);
    costUsd += numberValue(value.costUsd);
  }
  return { prompts, inputTokens, outputTokens, costUsd };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
