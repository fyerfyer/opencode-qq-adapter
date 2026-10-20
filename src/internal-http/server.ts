import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { HealthService } from "../observability/health.js";
import { bearerToken, tokenMatches } from "../util/token.js";

export class InternalHttpServer {
  readonly #config: AppConfig;
  readonly #health: HealthService;
  readonly #logger: Logger;
  #server: ServerType | null = null;
  #port = 0;

  constructor(config: AppConfig, health: HealthService, logger: Logger) {
    this.#config = config;
    this.#health = health;
    this.#logger = logger;
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
        version: "0.1.0",
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

    app.post("/internal/plugin/send-image", (context) =>
      context.json(
        {
          error: "not_implemented",
          message: "Image forwarding is planned for milestone M4.",
        },
        501,
      ),
    );
    app.post("/internal/plugin/send-file", (context) =>
      context.json(
        {
          error: "not_implemented",
          message: "File forwarding is planned for milestone M4.",
        },
        501,
      ),
    );

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
      instance.once("error", reject);
    });
    this.#server = server;
    const address = server.address() as AddressInfo | null;
    this.#port = address?.port ?? this.#config.server.port;
    this.#logger.info(
      { host: this.#config.server.host, port: this.#port, health: this.#config.server.health_path },
      "Internal HTTP server listening",
    );
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
