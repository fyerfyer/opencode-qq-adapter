import type { Logger } from "pino";
import type { AppConfig } from "./config/schema.js";
import { ConversationManager } from "./conversation/manager.js";
import type { IncomingMessage } from "./domain/message.js";
import { InternalHttpServer } from "./internal-http/server.js";
import { HealthService } from "./observability/health.js";
import { buildLogger } from "./observability/logger.js";
import { NapCatOneBotAdapter } from "./onebot/napcat.js";
import { isMessageEvent, type OneBotEvent } from "./onebot/protocol.js";
import { toIncomingMessage } from "./onebot/segments.js";
import { OpenCodeAgent } from "./opencode/agent.js";
import { PolicyEngine } from "./policy/engine.js";
import type { AgentPort } from "./ports/agent.js";
import type { OneBotPort } from "./ports/onebot.js";
import type { StorePort } from "./ports/store.js";
import { MessageSender } from "./qq/sender.js";
import { MessageRouter } from "./router/router.js";
import { SqliteStore } from "./store/sqlite.js";
import { VERSION } from "./version.js";

export interface AppDependencies {
  logger?: Logger;
  store?: StorePort;
  onebot?: OneBotPort;
  agent?: AgentPort;
  sender?: MessageSender;
}

export class App {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly store: StorePort;
  readonly onebot: OneBotPort;
  readonly agent: AgentPort;
  readonly policy: PolicyEngine;
  readonly conversations: ConversationManager;
  readonly router: MessageRouter;
  readonly health: HealthService;
  readonly http: InternalHttpServer;

  #unsubscribeOneBot: (() => void) | null = null;
  #started = false;
  #stopped = false;
  #lastSeenPrune = 0;

  constructor(config: AppConfig, dependencies: AppDependencies = {}) {
    this.config = config;
    this.logger = dependencies.logger ?? buildLogger(config);
    this.store = dependencies.store ?? new SqliteStore(config.storage.database_path);
    this.onebot = dependencies.onebot ?? new NapCatOneBotAdapter(config.onebot, this.logger);
    this.agent = dependencies.agent ?? new OpenCodeAgent(config.opencode, this.logger);
    const sender = dependencies.sender ?? new MessageSender(this.onebot, config.qq, this.logger);
    this.policy = new PolicyEngine(config);
    this.conversations = new ConversationManager(
      config,
      this.store,
      this.agent,
      sender,
      this.logger,
    );
    this.router = new MessageRouter({
      config,
      policy: this.policy,
      conversations: this.conversations,
      sender,
      agent: this.agent,
      onebot: this.onebot,
      logger: this.logger,
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
    this.http = new InternalHttpServer(config, this.health, this.logger);
  }

  get httpPort(): number {
    return this.http.port;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#unsubscribeOneBot = this.onebot.onEvent((event) => this.#onOneBotEvent(event));
    try {
      await this.http.start();
      await this.onebot.start();
      await this.agent.start();
    } catch (error) {
      this.logger.error({ err: error }, "Failed to start bridge");
      await this.stop();
      throw error;
    }
    this.#started = true;
    this.logger.info(
      {
        version: VERSION,
        httpPort: this.httpPort,
        onebotUrl: this.config.onebot.url,
        opencodeMode: this.config.opencode.service.mode,
      },
      "OpenCode QQ Adapter started",
    );
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#unsubscribeOneBot?.();
    this.#unsubscribeOneBot = null;
    await this.conversations.shutdown().catch((error) => {
      this.logger.warn({ err: error }, "Conversation manager shutdown failed");
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
