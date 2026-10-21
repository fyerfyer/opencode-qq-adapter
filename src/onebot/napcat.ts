import { NCWebsocket, type SendMessageSegment, Structs } from "node-napcat-ts";
import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import { type ChatRef, type OutgoingSegment, replySegment } from "../domain/chat.js";
import type { OneBotPort, OneBotSendResult, OneBotStatus } from "../ports/onebot.js";

export interface NapCatClientLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(event: string, handler: (context: unknown) => void): unknown;
  send_private_msg(params: {
    user_id: number;
    message: SendMessageSegment[];
  }): Promise<{ message_id: number }>;
  send_group_msg(params: {
    group_id: number;
    message: SendMessageSegment[];
  }): Promise<{ message_id: number }>;
  get_image?(params: { file: string }): Promise<{
    file: string;
    url: string;
    file_size: string;
    file_name: string;
  }>;
  upload_private_file(params: { user_id: number; file: string; name: string }): Promise<null>;
  upload_group_file(params: {
    group_id: number;
    file: string;
    name: string;
    folder_id?: string;
  }): Promise<null>;
  delete_msg?(params: { message_id: string | number }): Promise<null>;
  get_login_info?(): Promise<{ user_id: number; nickname: string }>;
}

export class OneBotError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OneBotError";
  }
}

export class OneBotNotConnectedError extends OneBotError {
  constructor() {
    super("NapCat websocket is not connected");
    this.name = "OneBotNotConnectedError";
  }
}

type OneBotConfig = AppConfig["onebot"];

/**
 * NapCat / OneBot 11 adapter backed by node-napcat-ts.
 *
 * The SDK owns the websocket connection, action correlation and reconnection.
 * We only map its events/segments to the bridge domain and expose the stable
 * OneBotPort used by the application layer.
 */
export class NapCatOneBotAdapter implements OneBotPort {
  readonly #config: OneBotConfig;
  readonly #logger: Logger;
  readonly #clientFactory: (() => NapCatClientLike) | undefined;
  #client: NapCatClientLike | null = null;
  #listeners = new Set<(event: unknown) => void>();
  #connected = false;
  #lastConnectedAt: number | null = null;
  #lastEventAt: number | null = null;
  #lastError: string | null = null;
  #selfId: number | null;

  constructor(
    config: OneBotConfig,
    logger: Logger,
    options: { clientFactory?: () => NapCatClientLike } = {},
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#clientFactory = options.clientFactory;
    this.#selfId = config.self_id ?? null;
  }

  async start(): Promise<void> {
    if (this.#client !== null) return;
    const client = this.#clientFactory?.() ?? this.#createClient();
    this.#client = client;
    this.#attach(client);
    try {
      await this.#connectWithTimeout(client);
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#logger.warn({ err: error }, "Initial NapCat connection failed; SDK will retry");
    }
  }

  async stop(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#connected = false;
    if (client !== null) {
      await client.disconnect().catch((error) => {
        this.#logger.warn({ err: error }, "Failed to disconnect NapCat SDK");
      });
    }
    this.#listeners.clear();
  }

  status(): OneBotStatus {
    return {
      mode: "forward",
      connected: this.#connected,
      selfId: this.#selfId,
      lastEventAt: this.#lastEventAt,
      lastConnectedAt: this.#lastConnectedAt,
      lastError: this.#lastError,
    };
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async sendPrivate(userId: number, segments: OutgoingSegment[]): Promise<OneBotSendResult> {
    const client = this.#requireClient();
    try {
      const result = await this.#withTimeout(
        client.send_private_msg({
          user_id: userId,
          message: toSdkSegments(segments),
        }),
        this.#config.action_timeout_ms,
        "send_private_msg",
      );
      return { messageId: String(result.message_id) };
    } catch (error) {
      throw wrapActionError("send_private_msg", error);
    }
  }

  async sendGroup(groupId: number, segments: OutgoingSegment[]): Promise<OneBotSendResult> {
    const client = this.#requireClient();
    try {
      const result = await this.#withTimeout(
        client.send_group_msg({
          group_id: groupId,
          message: toSdkSegments(segments),
        }),
        this.#config.action_timeout_ms,
        "send_group_msg",
      );
      return { messageId: String(result.message_id) };
    } catch (error) {
      throw wrapActionError("send_group_msg", error);
    }
  }

  async reply(
    chat: ChatRef,
    messageId: string,
    segments: OutgoingSegment[],
  ): Promise<OneBotSendResult> {
    const withReply = [replySegment(messageId), ...segments];
    if (chat.type === "group" && chat.groupId !== undefined) {
      return this.sendGroup(chat.groupId, withReply);
    }
    return this.sendPrivate(chat.userId, withReply);
  }

  async getImage(file: string): Promise<{ file: string; url: string; fileName: string }> {
    const client = this.#requireClient();
    if (client.get_image === undefined) {
      throw new OneBotError("NapCat client does not expose get_image");
    }
    try {
      const result = await this.#withTimeout(
        client.get_image({ file }),
        this.#config.action_timeout_ms,
        "get_image",
      );
      return { file: result.file, url: result.url, fileName: result.file_name };
    } catch (error) {
      throw wrapActionError("get_image", error);
    }
  }

  async uploadPrivateFile(userId: number, file: string, name: string): Promise<void> {
    const client = this.#requireClient();
    try {
      await this.#withTimeout(
        client.upload_private_file({ user_id: userId, file, name }),
        this.#config.upload_timeout_ms,
        "upload_private_file",
      );
    } catch (error) {
      throw wrapActionError("upload_private_file", error);
    }
  }

  async uploadGroupFile(
    groupId: number,
    file: string,
    name: string,
    folderId?: string,
  ): Promise<void> {
    const client = this.#requireClient();
    try {
      await this.#withTimeout(
        client.upload_group_file({
          group_id: groupId,
          file,
          name,
          ...(folderId ? { folder_id: folderId } : {}),
        }),
        this.#config.upload_timeout_ms,
        "upload_group_file",
      );
    } catch (error) {
      throw wrapActionError("upload_group_file", error);
    }
  }

  async deleteMessage(messageId: string): Promise<void> {
    const client = this.#requireClient();
    if (client.delete_msg === undefined) {
      throw new OneBotError("NapCat client does not expose delete_msg");
    }
    try {
      await this.#withTimeout(
        client.delete_msg({ message_id: messageId }),
        this.#config.action_timeout_ms,
        "delete_msg",
      );
    } catch (error) {
      throw wrapActionError("delete_msg", error);
    }
  }

  async getLoginInfo(): Promise<{ userId: number; nickname: string }> {
    const client = this.#requireClient();
    if (client.get_login_info === undefined) {
      throw new OneBotError("NapCat client does not expose get_login_info");
    }
    const info = await client.get_login_info();
    this.#selfId = info.user_id;
    return { userId: info.user_id, nickname: info.nickname };
  }

  #createClient(): NapCatClientLike {
    const url = new URL(this.#config.url);
    // The SDK appends `?access_token=...` itself; drop any user-provided query.
    url.search = "";
    url.hash = "";
    const client = new NCWebsocket(
      {
        baseUrl: url.toString(),
        accessToken: this.#config.access_token,
        apiTimeout: Math.max(this.#config.action_timeout_ms, this.#config.upload_timeout_ms),
        reconnection: {
          enable: this.#config.reconnect.enabled,
          attempts: this.#config.reconnect.attempts,
          delay: this.#config.reconnect.delay_ms,
        },
      },
      false,
    );
    return client as unknown as NapCatClientLike;
  }

  #attach(client: NapCatClientLike): void {
    client.on("socket.open", () => {
      this.#connected = true;
      this.#lastConnectedAt = Date.now();
      this.#lastError = null;
      this.#logger.info({ url: this.#config.url }, "NapCat websocket connected");
      void this.#refreshLoginInfo(client);
    });
    client.on("socket.close", (context) => {
      this.#connected = false;
      const info = context as { code?: number; reason?: string };
      this.#lastError = `websocket closed (${info.code ?? "?"} ${info.reason ?? ""})`;
      this.#logger.warn(info, "NapCat websocket closed");
    });
    client.on("socket.error", (context) => {
      this.#lastError = describeSocketError(context);
      this.#logger.warn({ error: context }, "NapCat websocket error");
    });
    client.on("message", (context) => this.#emit(context));
    client.on("meta_event.heartbeat", (context) => {
      this.#touch(context);
      this.#emit(context);
    });
    client.on("meta_event.lifecycle", (context) => {
      this.#touch(context);
      this.#emit(context);
    });
    client.on("notice", (context) => this.#emit(context));
    client.on("request", (context) => this.#emit(context));
  }

  async #refreshLoginInfo(client: NapCatClientLike): Promise<void> {
    if (client.get_login_info === undefined) return;
    try {
      const info = await client.get_login_info();
      this.#selfId = info.user_id;
      this.#logger.info({ selfId: info.user_id, nickname: info.nickname }, "NapCat login info");
    } catch (error) {
      this.#logger.debug({ err: error }, "Could not read NapCat login info");
    }
  }

  #touch(context: unknown): void {
    this.#lastEventAt = Date.now();
    if (context !== null && typeof context === "object") {
      const selfId = Number((context as { self_id?: unknown }).self_id);
      if (Number.isFinite(selfId) && selfId > 0) this.#selfId = selfId;
    }
  }

  #emit(context: unknown): void {
    this.#touch(context);
    for (const listener of this.#listeners) {
      try {
        listener(context);
      } catch (error) {
        this.#logger.error({ err: error }, "OneBot event listener failed");
      }
    }
  }

  #requireClient(): NapCatClientLike {
    if (this.#client === null || !this.#connected) {
      throw new OneBotNotConnectedError();
    }
    return this.#client;
  }

  async #withTimeout<T>(promise: Promise<T>, timeoutMs: number, action: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new OneBotError(`OneBot action '${action}' timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #connectWithTimeout(client: NapCatClientLike): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Timed out connecting to NapCat websocket")),
            5_000,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export function toSdkSegments(segments: OutgoingSegment[]): SendMessageSegment[] {
  return segments.map((segment) => {
    switch (segment.type) {
      case "text":
        return Structs.text(segment.text);
      case "at":
        return Structs.at(segment.qq);
      case "reply":
        return Structs.reply(segment.messageId);
      case "image":
        return Structs.image(segment.file);
      case "file":
        return Structs.file(segment.file, segment.name);
      default:
        throw new OneBotError(
          `Unsupported outgoing segment type: ${(segment as { type: string }).type}`,
        );
    }
  });
}

function wrapActionError(action: string, error: unknown): OneBotError {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return new OneBotError(`OneBot action '${action}' failed: ${message}`, { cause: error });
}

function describeSocketError(context: unknown): string {
  if (context === null || typeof context !== "object") return "unknown websocket error";
  const record = context as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (record.info !== undefined) return JSON.stringify(record.info);
  return JSON.stringify(record);
}
