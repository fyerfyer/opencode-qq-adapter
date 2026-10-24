import type { Logger } from "pino";
import type { AdminBootstrap } from "./admin/auth.js";
import { AdminService } from "./admin/service.js";
import { ApprovalBroker } from "./approval/broker.js";
import { loadConfig } from "./config/loader.js";
import { envFilesForConfig, loadEnvFiles } from "./config/paths.js";
import { applyHotConfig, type ConfigReloadResult } from "./config/reload.js";
import type { AppConfig } from "./config/schema.js";
import { ConversationManager } from "./conversation/manager.js";
import { SessionOwnership } from "./conversation/ownership.js";
import type { IncomingMessage } from "./domain/message.js";
import { InternalHttpServer } from "./internal-http/server.js";
import { InboundMediaService } from "./media/inbound.js";
import { PluginMediaService } from "./media/plugin.js";
import { AuditTrail } from "./observability/audit.js";
import { HealthService } from "./observability/health.js";
import { buildLogger } from "./observability/logger.js";
import { OwnerNotifier } from "./observability/notifier.js";
import { NapCatOneBotAdapter } from "./onebot/napcat.js";
import { isMessageEvent, type OneBotEvent } from "./onebot/protocol.js";
import { toIncomingMessage } from "./onebot/segments.js";
import { OpenCodeAgent } from "./opencode/agent.js";
import { PluginHost } from "./plugins/host.js";
import { PolicyEngine } from "./policy/engine.js";
import { QuotaService } from "./policy/quota.js";
import type { AgentPort } from "./ports/agent.js";
import type { OneBotPort } from "./ports/onebot.js";
import type { StorePort } from "./ports/store.js";
import { MessageSender } from "./qq/sender.js";
import { CORE_COMMAND_NAMES } from "./router/commands.js";
import { MessageRouter } from "./router/router.js";
import { SudoService } from "./security/sudo.js";
import { SqliteStore } from "./store/sqlite.js";
import { VERSION } from "./version.js";
import { WorkspaceManager } from "./workspace/manager.js";

export interface AppDependencies {
  logger?: Logger;
  /** Config file used by `!reload` / SIGHUP. */
  configPath?: string;
  store?: StorePort;
  onebot?: OneBotPort;
  agent?: AgentPort;
  sender?: MessageSender;
  workspaces?: WorkspaceManager;
  plugins?: PluginHost;
  media?: InboundMediaService;
  pluginMedia?: PluginMediaService;
  notifier?: OwnerNotifier;
  admin?: AdminService;
  /** One-time bootstrap password for the local admin UI (tests / automation). */
  adminPassword?: string;
  /** Override the OpenCode agent prompt directory (tests). */
  promptRoot?: string;
}

export class App {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly store: StorePort;
  readonly onebot: OneBotPort;
  readonly agent: AgentPort;
  readonly policy: PolicyEngine;
  readonly audit: AuditTrail;
  readonly quota: QuotaService;
  readonly workspaces: WorkspaceManager;
  readonly plugins: PluginHost;
  readonly ownership: SessionOwnership;
  readonly media: InboundMediaService;
  readonly pluginMedia: PluginMediaService;
  readonly notifier: OwnerNotifier;
  readonly sudo: SudoService;
  readonly conversations: ConversationManager;
  readonly approvals: ApprovalBroker;
  readonly router: MessageRouter;
  readonly health: HealthService;
  readonly admin: AdminService;
  readonly http: InternalHttpServer;

  readonly #configPath: string | null;
  #unsubscribeOneBot: (() => void) | null = null;
  #started = false;
  #stopped = false;
  #lastSeenPrune = 0;
  #pruneTimer: NodeJS.Timeout | null = null;
  #loginProbeTimer: NodeJS.Timeout | null = null;

  constructor(config: AppConfig, dependencies: AppDependencies = {}) {
    this.config = config;
    this.#configPath = dependencies.configPath ?? null;
    this.logger = dependencies.logger ?? buildLogger(config);
    this.store = dependencies.store ?? new SqliteStore(config.storage.database_path);
    this.onebot = dependencies.onebot ?? new NapCatOneBotAdapter(config.onebot, this.logger);
    this.agent = dependencies.agent ?? new OpenCodeAgent(config.opencode, this.logger);
    const sender = dependencies.sender ?? new MessageSender(this.onebot, config.qq, this.logger);
    this.policy = new PolicyEngine(config);
    this.audit = new AuditTrail(this.store, this.logger);
    this.quota = new QuotaService({ config, store: this.store });
    this.workspaces =
      dependencies.workspaces ??
      new WorkspaceManager({ config, store: this.store, logger: this.logger });
    let conversationsRef: ConversationManager | null = null;
    this.plugins =
      dependencies.plugins ??
      new PluginHost({
        config,
        logger: this.logger,
        audit: this.audit,
        sender,
        conversations: {
          getConversation: (chatKey) => conversationsRef?.getConversation(chatKey) ?? null,
        },
        reservedCommands: CORE_COMMAND_NAMES,
        coreVersion: VERSION,
      });
    this.ownership = new SessionOwnership(this.store, this.agent, this.logger);
    this.media =
      dependencies.media ??
      new InboundMediaService({ config, onebot: this.onebot, logger: this.logger });
    this.notifier =
      dependencies.notifier ?? new OwnerNotifier({ config, sender, logger: this.logger });
    this.sudo = new SudoService(config.security.admin_2fa);
    this.conversations = new ConversationManager(
      config,
      this.store,
      this.agent,
      sender,
      this.logger,
      {
        quota: this.quota,
        audit: this.audit,
        workspaces: this.workspaces,
        plugins: this.plugins,
        onRunFailed: (active, error) => {
          void this.notifier.runFailed(active, error);
        },
      },
    );
    conversationsRef = this.conversations;
    this.approvals = new ApprovalBroker({
      config,
      store: this.store,
      agent: this.agent,
      sender,
      policy: this.policy,
      audit: this.audit,
      logger: this.logger,
    });
    this.pluginMedia =
      dependencies.pluginMedia ??
      new PluginMediaService({
        config,
        store: this.store,
        ownership: this.ownership,
        workspaces: this.workspaces,
        sender,
        audit: this.audit,
        logger: this.logger,
      });
    this.router = new MessageRouter({
      config,
      policy: this.policy,
      conversations: this.conversations,
      approvals: this.approvals,
      quota: this.quota,
      audit: this.audit,
      sender,
      agent: this.agent,
      onebot: this.onebot,
      media: this.media,
      workspaces: this.workspaces,
      sudo: this.sudo,
      notifier: this.notifier,
      plugins: this.plugins,
      logger: this.logger,
      reloadConfig: () => this.reloadConfig(),
    });
    this.health = new HealthService({
      config,
      onebot: this.onebot,
      agent: this.agent,
      store: this.store,
      conversations: this.conversations,
      logger: this.logger,
      version: VERSION,
    });
    const initialAdminPassword =
      dependencies.adminPassword ?? process.env.OPENCODE_QQ_ADMIN_PASSWORD;
    this.admin =
      dependencies.admin ??
      new AdminService({
        config,
        configPath: this.#configPath,
        version: VERSION,
        store: this.store,
        health: this.health,
        agent: this.agent,
        conversations: this.conversations,
        audit: this.audit,
        plugins: this.plugins,
        logger: this.logger,
        reloadConfig: () => this.reloadConfig(),
        ...(initialAdminPassword !== undefined && initialAdminPassword.length > 0
          ? { initialPassword: initialAdminPassword }
          : {}),
        ...(dependencies.promptRoot !== undefined ? { promptRoot: dependencies.promptRoot } : {}),
      });
    this.http = new InternalHttpServer(config, this.health, this.logger, {
      pluginMedia: this.pluginMedia,
      admin: this.admin,
    });
  }

  get httpPort(): number {
    return this.http.port;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    const recoveredWorkspaces = this.workspaces.recover();
    if (recoveredWorkspaces > 0) {
      this.audit.record({
        ts: Date.now(),
        actorQq: null,
        chatKey: null,
        projectId: null,
        workspaceId: null,
        action: "workspaces.recovered",
        detail: { count: recoveredWorkspaces },
      });
    }
    this.audit.prune(this.config.logging.audit_retention_days);
    const prunedImages = await this.media.cleanupInbox().catch(() => 0);
    if (prunedImages > 0) this.logger.info({ prunedImages }, "Pruned expired inbox images");
    this.#unsubscribeOneBot = this.onebot.onEvent((event) => this.#onOneBotEvent(event));
    this.ownership.start();
    try {
      const adminBootstrap = this.config.admin.enabled ? await this.admin.start() : null;
      await this.http.start();
      if (adminBootstrap !== null) this.#announceAdmin(adminBootstrap);
      await this.agent.start();
      await this.plugins.start();
      this.approvals.start();
      await this.onebot.start();
    } catch (error) {
      this.logger.error({ err: error }, "Failed to start bridge");
      await this.stop();
      throw error;
    }
    this.#pruneTimer = setInterval(
      () => {
        this.audit.prune(this.config.logging.audit_retention_days);
        void this.media.cleanupInbox().catch(() => 0);
        this.workspaces.cleanup();
      },
      60 * 60 * 1000,
    );
    this.#pruneTimer.unref?.();
    this.#startLoginProbe();
    this.#started = true;
    this.logger.info(
      {
        version: VERSION,
        httpPort: this.httpPort,
        onebotUrl: this.config.onebot.url,
        opencodeMode: this.config.opencode.service.mode,
        recoveredWorkspaces,
        recoveredRuns: this.conversations.recoveredRuns,
      },
      "OpenCode QQ Adapter started",
    );
    void this.notifier.startup(this.conversations.recoveredRuns, recoveredWorkspaces);
  }

  /**
   * Re-read the configuration file and apply the hot-reloadable subset.
   * A validation failure never changes the running configuration.
   */
  async reloadConfig(): Promise<ConfigReloadResult> {
    if (this.#configPath === null) {
      return {
        ok: false,
        applied: [],
        restartRequired: [],
        warnings: [],
        error: "No configuration path is associated with this process.",
      };
    }
    if (this.#stopped) {
      return {
        ok: false,
        applied: [],
        restartRequired: [],
        warnings: [],
        error: "Bridge is shutting down.",
      };
    }

    let loaded: Awaited<ReturnType<typeof loadConfig>>;
    try {
      // Pick up newly added variables in .env. Existing process variables keep
      // precedence, so a running systemd EnvironmentFile is not overridden.
      loadEnvFiles(envFilesForConfig(this.#configPath));
      loaded = await loadConfig(this.#configPath, { checkPaths: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error }, "Configuration reload failed; keeping old config");
      return {
        ok: false,
        applied: [],
        restartRequired: [],
        warnings: [],
        error: message,
      };
    }

    const { applied, restartRequired } = applyHotConfig(this.config, loaded.config);
    this.admin.updateSettings();
    this.logger.level = this.config.logging.level;
    const warnings = [...loaded.warnings];
    const pluginReport = await this.plugins.reload();
    if (pluginReport.failed > 0) {
      warnings.push(`${pluginReport.failed} 个插件加载失败；发送 !plugins 查看详情`);
    }
    await this.plugins
      .configReloaded({ applied, restartRequired })
      .catch((error) => this.logger.warn({ err: error }, "Plugin config reload hooks failed"));
    this.audit.record({
      ts: Date.now(),
      actorQq: null,
      chatKey: null,
      projectId: null,
      workspaceId: null,
      action: "config.reloaded",
      detail: { applied, restartRequired, warnings, plugins: pluginReport },
    });
    this.logger.info(
      { applied, restartRequired, warnings, plugins: pluginReport },
      "Configuration reloaded",
    );
    return {
      ok: true,
      applied,
      restartRequired,
      warnings,
    };
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#pruneTimer !== null) {
      clearInterval(this.#pruneTimer);
      this.#pruneTimer = null;
    }
    if (this.#loginProbeTimer !== null) {
      clearInterval(this.#loginProbeTimer);
      this.#loginProbeTimer = null;
    }
    this.#unsubscribeOneBot?.();
    this.#unsubscribeOneBot = null;
    this.ownership.stop();
    await this.approvals.stop().catch((error) => {
      this.logger.warn({ err: error }, "Approval broker shutdown failed");
    });
    await this.conversations.shutdown().catch((error) => {
      this.logger.warn({ err: error }, "Conversation manager shutdown failed");
    });
    await this.plugins.stop().catch((error) => {
      this.logger.warn({ err: error }, "Plugin host shutdown failed");
    });
    await this.onebot.stop().catch((error) => {
      this.logger.warn({ err: error }, "OneBot shutdown failed");
    });
    await this.http.stop().catch((error) => {
      this.logger.warn({ err: error }, "HTTP shutdown failed");
    });
    await this.agent.stop().catch((error) => {
      this.logger.warn({ err: error }, "OpenCode shutdown failed");
    });
    this.store.close();
    this.logger.info("OpenCode QQ Adapter stopped");
  }

  #announceAdmin(bootstrap: AdminBootstrap): void {
    const configuredHost = this.config.server.host;
    const host =
      configuredHost === "0.0.0.0" || configuredHost === "::" || configuredHost === ""
        ? "127.0.0.1"
        : configuredHost;
    const url = `http://${host}:${this.httpPort}/admin`;
    if (bootstrap.password !== undefined) {
      this.logger.warn(
        {
          url,
          username: bootstrap.username,
          password: bootstrap.password,
        },
        "Admin WebUI created its initial password. Save it now; it will not be shown again.",
      );
    } else {
      this.logger.info({ url, username: bootstrap.username }, "Admin WebUI is available");
    }
  }

  #startLoginProbe(): void {
    const interval = this.config.onebot.login_probe_ms;
    if (interval <= 0 || this.onebot.getLoginInfo === undefined) return;
    this.#loginProbeTimer = setInterval(() => {
      void this.#probeNapCatLogin();
    }, interval);
    this.#loginProbeTimer.unref?.();
  }

  async #probeNapCatLogin(): Promise<void> {
    if (!this.onebot.status().connected) return;
    try {
      await this.onebot.getLoginInfo?.();
    } catch (error) {
      this.logger.warn({ err: error }, "NapCat login probe failed");
      void this.notifier.notify(
        [
          "⚠️ NapCat / QQ 登录可能已失效",
          "OneBot WebSocket 仍连接，但 get_login_info 失败。",
          "请在 NapCat WebUI 检查二维码或快速登录；bridge 会继续重连。",
        ].join("\n"),
        { key: "napcat-login-lost", ttlMs: 30 * 60 * 1000 },
      );
    }
  }

  #onOneBotEvent(raw: unknown): void {
    const event = raw as OneBotEvent;
    if (!isMessageEvent(event)) return;
    const selfId = this.onebot.status().selfId;
    if (selfId !== null && Number(event.user_id) === selfId) return;

    const messageId = String(event.message_id);
    const now = Date.now();
    if (!this.store.seenMessages.mark(messageId, now)) {
      this.logger.debug({ messageId }, "Ignoring duplicate OneBot message");
      return;
    }
    if (now - this.#lastSeenPrune > 60_000) {
      this.#lastSeenPrune = now;
      const pruned = this.store.seenMessages.prune(now - this.config.onebot.dedupe_ttl_ms);
      if (pruned > 0) this.logger.debug({ pruned }, "Pruned seen message IDs");
    }

    let message: IncomingMessage;
    try {
      message = toIncomingMessage(event, selfId, (groupId) => this.policy.groupMode(groupId));
    } catch (error) {
      this.logger.warn({ err: error, messageId }, "Failed to parse OneBot message event");
      return;
    }

    this.logger.info(
      {
        messageId,
        chatKey: message.chat.chatKey,
        userId: message.userId,
        length: message.text.length,
        images: message.images.length,
        command: message.text.startsWith("!"),
      },
      "Received QQ message",
    );

    void this.router.handle(message).catch((error) => {
      this.logger.error({ err: error, chatKey: message.chat.chatKey }, "Router failed");
    });
  }
}
