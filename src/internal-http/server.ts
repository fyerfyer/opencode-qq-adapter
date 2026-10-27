import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import { createAdminApi } from "../admin/routes.js";
import { AdminError, type AdminService } from "../admin/service.js";
import { adminBuildHint, adminDistRoot, readAdminIndex } from "../admin/ui.js";
import type { AppConfig } from "../config/schema.js";
import { PluginMediaError, type PluginMediaService } from "../media/plugin.js";
import type { HealthService } from "../observability/health.js";
import { bearerToken, tokenMatches } from "../util/token.js";
import { VERSION } from "../version.js";

const sendMediaBody = z
  .object({
    sessionId: z.string().min(1),
    path: z.string().min(1),
    caption: z.string().max(1000).optional(),
  })
  .strict();

export interface InternalHttpOptions {
  pluginMedia?: PluginMediaService;
  admin?: AdminService;
}

export class InternalHttpServer {
  readonly #config: AppConfig;
  readonly #health: HealthService;
  readonly #logger: Logger;
  readonly #pluginMedia: PluginMediaService | undefined;
  readonly #admin: AdminService | undefined;
  #server: ServerType | null = null;
  #port = 0;

  constructor(
    config: AppConfig,
    health: HealthService,
    logger: Logger,
    options: InternalHttpOptions = {},
  ) {
    this.#config = config;
    this.#health = health;
    this.#logger = logger;
    this.#pluginMedia = options.pluginMedia;
    this.#admin = options.admin;
  }

  get port(): number {
    return this.#port;
  }

  async start(): Promise<void> {
    if (this.#server !== null) return;
    const app = new Hono();

    app.get("/", (context) =>
      context.json({
        name: "opencode-qq-adapter",
        version: VERSION,
        health: this.#config.server.health_path,
      }),
    );

    app.get(this.#config.server.health_path, async (context) => {
      const snapshot = await this.#health.snapshot();
      const statusCode = snapshot.status === "error" ? 503 : 200;
      return context.json(snapshot, statusCode as 200 | 503);
    });

    if (this.#config.features.metrics) {
      app.get("/metrics", async (context) => {
        const snapshot = await this.#health.snapshot();
        const lines = [
          "# HELP opencode_qq_up Bridge process is up.",
          "# TYPE opencode_qq_up gauge",
          "opencode_qq_up 1",
          "# HELP opencode_qq_onebot_connected OneBot websocket connection state.",
          "# TYPE opencode_qq_onebot_connected gauge",
          `opencode_qq_onebot_connected ${snapshot.onebot.connected ? 1 : 0}`,
          "# HELP opencode_qq_opencode_healthy OpenCode service health.",
          "# TYPE opencode_qq_opencode_healthy gauge",
          `opencode_qq_opencode_healthy ${snapshot.opencode.healthy ? 1 : 0}`,
          "# HELP opencode_qq_queue_depth Number of queued prompts.",
          "# TYPE opencode_qq_queue_depth gauge",
          `opencode_qq_queue_depth ${snapshot.queue.depth}`,
          "# HELP opencode_qq_active_runs Number of active runs.",
          "# TYPE opencode_qq_active_runs gauge",
          `opencode_qq_active_runs ${snapshot.queue.active}`,
        ];
        return context.text(`${lines.join("\n")}\n`);
      });
    }

    app.use("/internal/*", async (context, next) => {
      if (this.#config.server.internal_token.length === 0) {
        return context.json(
          { error: "internal endpoints are disabled because server.internal_token is empty" },
          503,
        );
      }
      const token = bearerToken(context.req.header("authorization"));
      if (!tokenMatches(this.#config.server.internal_token, token)) {
        this.#logger.warn(
          { path: context.req.path, remote: context.req.header("x-forwarded-for") },
          "Rejected internal HTTP request with bad token",
        );
        return context.json({ error: "unauthorized" }, 401);
      }
      await next();
    });

    app.post("/internal/plugin/send-image", async (context) => {
      const plugin = this.#pluginMedia;
      if (plugin === undefined) {
        return context.json({ error: "plugin_media_disabled" }, 503);
      }
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        return context.json({ error: "invalid_json" }, 400);
      }
      const parsed = sendMediaBody.safeParse(body);
      if (!parsed.success) {
        return context.json(
          { error: "invalid_request", details: parsed.error.issues.map((issue) => issue.message) },
          400,
        );
      }
      try {
        const result = await plugin.sendImage(parsed.data);
        return context.json({ ok: true, messageId: result.messageId });
      } catch (error) {
        if (error instanceof PluginMediaError) {
          return context.json({ error: "media_rejected", message: error.message }, error.status);
        }
        this.#logger.error({ err: error }, "Plugin send-image failed");
        return context.json({ error: "internal_error" }, 500);
      }
    });
    app.post("/internal/plugin/send-file", async (context) => {
      const plugin = this.#pluginMedia;
      if (plugin === undefined) {
        return context.json({ error: "plugin_media_disabled" }, 503);
      }
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        return context.json({ error: "invalid_json" }, 400);
      }
      const parsed = sendMediaBody.safeParse(body);
      if (!parsed.success) {
        return context.json(
          { error: "invalid_request", details: parsed.error.issues.map((issue) => issue.message) },
          400,
        );
      }
      try {
        const result = await plugin.sendFile(parsed.data);
        return context.json({ ok: true, messageId: result.messageId });
      } catch (error) {
        if (error instanceof PluginMediaError) {
          return context.json({ error: "media_rejected", message: error.message }, error.status);
        }
        this.#logger.error({ err: error }, "Plugin send-file failed");
        return context.json({ error: "internal_error" }, 500);
      }
    });

    if (this.#config.admin.enabled && this.#admin !== undefined) {
      this.#mountAdmin(app, this.#admin);
    }

    app.notFound((context) => context.json({ error: "not_found" }, 404));
    app.onError((error, context) => {
      this.#logger.error({ err: error, path: context.req.path }, "Internal HTTP request failed");
      return context.json({ error: "internal_error" }, 500);
    });

    let instance: ServerType;
    const server = await new Promise<ServerType>((resolve, reject) => {
      instance = serve(
        {
          fetch: app.fetch,
          hostname: this.#config.server.host,
          port: this.#config.server.port,
        },
        (info) => {
          this.#port = info.port;
          resolve(instance);
        },
      );
      instance.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          reject(
            new Error(
              `HTTP port ${this.#config.server.port} is already in use. Another bridge may still be shutting down; check with: ss -ltnp | grep ${this.#config.server.port}`,
            ),
          );
          return;
        }
        reject(error);
      });
    });
    this.#server = server;
    const address = server.address() as AddressInfo | null;
    this.#port = address?.port ?? this.#config.server.port;
    this.#logger.info(
      { host: this.#config.server.host, port: this.#port, health: this.#config.server.health_path },
      "Internal HTTP server listening",
    );
  }

  #mountPluginUiAssets(app: Hono, admin: AdminService): void {
    const commonHeaders = (context: Context): void => {
      context.header("Access-Control-Allow-Origin", "*");
      context.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      context.header("Cross-Origin-Resource-Policy", "cross-origin");
      context.header("Referrer-Policy", "no-referrer");
      context.header("X-Content-Type-Options", "nosniff");
      context.header("X-Robots-Tag", "noindex, nofollow");
      context.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    };

    app.options("/admin/plugin-assets/*", (context) => {
      commonHeaders(context);
      context.header("Access-Control-Max-Age", "600");
      return context.body(null, 204);
    });

    app.on(["GET", "HEAD"], "/admin/plugin-assets/*", async (context) => {
      commonHeaders(context);
      const pathname = new URL(context.req.url).pathname;
      const match = /^\/admin\/plugin-assets\/([^/]+)\/([^/]+)\/(.+)$/.exec(pathname);
      if (match === null) {
        return context.text("插件页面资源不存在。", 404);
      }
      let token: string;
      let pluginId: string;
      let relativePath: string;
      try {
        token = decodeURIComponent(match[1] as string);
        pluginId = decodeURIComponent(match[2] as string);
        relativePath = decodeURIComponent(match[3] as string);
      } catch {
        return context.text("插件页面资源路径不合法。", 400);
      }
      try {
        const asset = await admin.readPluginUiAsset(token, pluginId, relativePath);
        const html = asset.contentType.startsWith("text/html");
        context.header("Content-Type", asset.contentType);
        context.header("Cache-Control", html ? "no-store" : asset.cacheControl);
        if (html) {
          context.header("X-Frame-Options", "SAMEORIGIN");
          context.header("Content-Security-Policy", pluginUiCsp(this.#config, context));
        }
        if (context.req.method === "HEAD") {
          return context.body(null, 200);
        }
        const body = asset.body.buffer.slice(
          asset.body.byteOffset,
          asset.body.byteOffset + asset.body.byteLength,
        ) as ArrayBuffer;
        return context.body(body, 200);
      } catch (error) {
        if (error instanceof AdminError) {
          return context.text(error.message, error.status as 400);
        }
        throw error;
      }
    });
  }

  #mountAdmin(app: Hono, admin: AdminService): void {
    const distRoot = adminDistRoot();
    app.use("/admin/*", async (context, next) => {
      // Plugin UI assets have their own token, CSP, CORS and framing policy.
      if (context.req.path.startsWith("/admin/plugin-assets/")) {
        await next();
        return;
      }
      context.header("X-Content-Type-Options", "nosniff");
      context.header("X-Frame-Options", "DENY");
      context.header("Referrer-Policy", "no-referrer");
      context.header("X-Robots-Tag", "noindex, nofollow");
      context.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
      );
      await next();
    });

    app.route(
      "/admin/api",
      createAdminApi({
        service: admin,
        config: this.#config,
        version: VERSION,
        logger: this.#logger,
      }),
    );

    this.#mountPluginUiAssets(app, admin);

    app.use("/admin/assets/*", async (context, next) => {
      context.header("Cache-Control", "public, max-age=31536000, immutable");
      await next();
    });
    app.use("/admin/assets/*", serveStatic({ root: distRoot }));
    app.get("/admin/assets/*", (context) => context.json({ error: "asset_not_found" }, 404));

    const serveIndex = async (context: Context): Promise<Response> => {
      if (context.req.path.startsWith("/admin/plugin-assets/")) return context.notFound();
      if (!this.#config.admin.enabled) return context.notFound();
      const html = await readAdminIndex();
      if (html === null) {
        return context.html(adminBuildHint(), 503);
      }
      context.header("Cache-Control", "no-store");
      return context.html(html);
    };
    app.get("/admin", serveIndex);
    app.get("/admin/", serveIndex);
    app.get("/admin/*", serveIndex);
    app.get("/favicon.ico", (context) => context.redirect("/admin/favicon.svg", 302));

    this.#logger.info({ path: "/admin", dist: distRoot }, "Admin WebUI enabled");
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.#logger.info("Internal HTTP server stopped");
  }
}

function pluginUiCsp(config: AppConfig, context: Context): string {
  const forwardedProto = context.req.header("x-forwarded-proto");
  const protocol =
    config.admin.trust_proxy && forwardedProto !== undefined
      ? forwardedProto.split(",")[0]?.trim()
      : undefined;
  const host =
    context.req.header("x-forwarded-host") ??
    context.req.header("host") ??
    new URL(context.req.url).host;
  let origin: string | null = null;
  try {
    origin = new URL(`${protocol ?? new URL(context.req.url).protocol.replace(":", "")}://${host}`)
      .origin;
  } catch {
    origin = null;
  }
  const source = origin === null ? "'self'" : `'self' ${origin}`;
  return [
    "default-src 'none'",
    `script-src ${source}`,
    `style-src ${source} 'unsafe-inline'`,
    `img-src ${source} data: blob:`,
    `font-src ${source} data:`,
    `media-src ${source} blob:`,
    "connect-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${origin === null ? "'self'" : `'self' ${origin}`}`,
  ].join("; ");
}
