import type { SendMessageSegment } from "node-napcat-ts";
import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { privateChat, replySegment, textSegment } from "../../src/domain/chat.js";
import { buildLogger } from "../../src/observability/logger.js";
import {
  type NapCatClientLike,
  NapCatOneBotAdapter,
  OneBotNotConnectedError,
  toSdkSegments,
} from "../../src/onebot/napcat.js";

class FakeNapCatClient implements NapCatClientLike {
  readonly handlers = new Map<string, Array<(context: unknown) => void>>();
  readonly sentPrivate: Array<{ user_id: number; message: SendMessageSegment[] }> = [];
  readonly sentGroup: Array<{ group_id: number; message: SendMessageSegment[] }> = [];
  readonly uploads: Array<Record<string, unknown>> = [];
  readonly getMessageIds: string[] = [];
  messageInfo: unknown = null;
  connected = false;
  disconnected = false;

  async connect(): Promise<void> {
    this.connected = true;
    this.emit("socket.open", { reconnection: {} });
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
    this.connected = false;
    this.emit("socket.close", { code: 1000, reason: "test" });
  }

  on(event: string, handler: (context: unknown) => void): unknown {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  emit(event: string, context: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(context);
  }

  async send_private_msg(params: {
    user_id: number;
    message: SendMessageSegment[];
  }): Promise<{ message_id: number }> {
    this.sentPrivate.push(params);
    return { message_id: 101 };
  }

  async send_group_msg(params: {
    group_id: number;
    message: SendMessageSegment[];
  }): Promise<{ message_id: number }> {
    this.sentGroup.push(params);
    return { message_id: 102 };
  }

  async upload_private_file(params: {
    user_id: number;
    file: string;
    name: string;
  }): Promise<null> {
    this.uploads.push({ action: "private", ...params });
    return null;
  }

  async upload_group_file(params: {
    group_id: number;
    file: string;
    name: string;
    folder_id?: string;
  }): Promise<null> {
    this.uploads.push({ action: "group", ...params });
    return null;
  }

  async get_login_info(): Promise<{ user_id: number; nickname: string }> {
    return { user_id: 10000, nickname: "FakeBot" };
  }

  async get_msg(params: { message_id: string | number }): Promise<unknown> {
    this.getMessageIds.push(String(params.message_id));
    return this.messageInfo;
  }
}

const config = configSchema.parse({
  version: 2,
  onebot: {
    url: "ws://127.0.0.1:3001",
    access_token: "token",
  },
});

const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });

describe("NapCatOneBotAdapter", () => {
  it("connects, learns login info and reports status", async () => {
    const client = new FakeNapCatClient();
    const adapter = new NapCatOneBotAdapter(config.onebot, logger, {
      clientFactory: () => client,
    });
    await adapter.start();
    expect(adapter.status()).toMatchObject({
      mode: "forward",
      connected: true,
      selfId: 10000,
      lastError: null,
    });
    expect(await adapter.getLoginInfo()).toEqual({ userId: 10000, nickname: "FakeBot" });
    await adapter.stop();
    expect(client.disconnected).toBe(true);
    expect(adapter.status().connected).toBe(false);
  });

  it("maps outgoing segments and sends private/group messages", async () => {
    const client = new FakeNapCatClient();
    const adapter = new NapCatOneBotAdapter(config.onebot, logger, {
      clientFactory: () => client,
    });
    await adapter.start();

    const result = await adapter.sendPrivate(20000, [
      textSegment("hello"),
      { type: "image", file: "/tmp/a.png" },
    ]);
    expect(result.messageId).toBe("101");
    expect(client.sentPrivate[0]?.user_id).toBe(20000);
    expect(client.sentPrivate[0]?.message[0]).toEqual({ type: "text", data: { text: "hello" } });
    expect(client.sentPrivate[0]?.message[1]).toMatchObject({
      type: "image",
      data: { file: "/tmp/a.png" },
    });

    await adapter.sendGroup(30000, [textSegment("group")]);
    expect(client.sentGroup[0]?.group_id).toBe(30000);
    expect(client.sentGroup[0]?.message).toEqual([{ type: "text", data: { text: "group" } }]);

    await adapter.reply(privateChat(20000), "55", [textSegment("reply")]);
    expect(client.sentPrivate[1]?.message[0]).toEqual({
      type: "reply",
      data: { id: "55" },
    });
  });

  it("exposes file upload actions", async () => {
    const client = new FakeNapCatClient();
    const adapter = new NapCatOneBotAdapter(config.onebot, logger, {
      clientFactory: () => client,
    });
    await adapter.start();
    await adapter.uploadPrivateFile(20000, "/shared/media/a.txt", "a.txt");
    await adapter.uploadGroupFile(30000, "/shared/media/b.txt", "b.txt", "folder");
    expect(client.uploads).toEqual([
      { action: "private", user_id: 20000, file: "/shared/media/a.txt", name: "a.txt" },
      {
        action: "group",
        group_id: 30000,
        file: "/shared/media/b.txt",
        name: "b.txt",
        folder_id: "folder",
      },
    ]);
  });

  it("forwards SDK events to subscribers", async () => {
    const client = new FakeNapCatClient();
    const adapter = new NapCatOneBotAdapter(config.onebot, logger, {
      clientFactory: () => client,
    });
    await adapter.start();
    const received: unknown[] = [];
    adapter.onEvent((event) => received.push(event));
    const event = {
      post_type: "message",
      message_type: "private",
      self_id: 10000,
      user_id: 20000,
      message_id: 1,
      message: [{ type: "text", data: { text: "hi" } }],
    };
    client.emit("message", event);
    expect(received).toEqual([event]);
    expect(adapter.status().lastEventAt).not.toBeNull();
  });

  it("rejects sends while disconnected", async () => {
    const adapter = new NapCatOneBotAdapter(config.onebot, logger, {
      clientFactory: () => new FakeNapCatClient(),
    });
    await expect(adapter.sendPrivate(20000, [textSegment("hi")])).rejects.toBeInstanceOf(
      OneBotNotConnectedError,
    );
  });

  it("fetches quoted messages through get_msg and preserves string ids", async () => {
    const client = new FakeNapCatClient();
    client.messageInfo = {
      time: 1_700_000_000,
      self_id: 10000,
      message_type: "group",
      group_id: 30000,
      user_id: 20000,
      message_id: "9007199254740993",
      message: [
        { type: "text", data: { text: " 白饭 " } },
        { type: "image", data: { file: "a.jpg" } },
        { type: "record", data: {} },
      ],
      sender: { user_id: 20000, nickname: "鱼片", card: "鱼片" },
    };
    const adapter = new NapCatOneBotAdapter(config.onebot, logger, {
      clientFactory: () => client,
    });
    await adapter.start();

    const info = await adapter.getMessage("9007199254740993");
    expect(client.getMessageIds).toEqual(["9007199254740993"]);
    expect(info).toMatchObject({
      messageId: "9007199254740993",
      messageType: "group",
      groupId: 30000,
      userId: 20000,
      senderName: "鱼片",
      text: "白饭",
      receivedAt: 1_700_000_000_000,
      unsupported: ["record"],
    });
    expect(info?.images).toEqual([{ file: "a.jpg" }]);
  });

  it("returns null when get_msg has no message", async () => {
    const client = new FakeNapCatClient();
    const adapter = new NapCatOneBotAdapter(config.onebot, logger, {
      clientFactory: () => client,
    });
    await adapter.start();
    expect(await adapter.getMessage("404")).toBeNull();
  });

  it("maps domain segments to SDK Structs", () => {
    expect(
      toSdkSegments([
        replySegment("1"),
        { type: "at", qq: "20000" },
        textSegment("hi"),
        { type: "image", file: "/tmp/a.png" },
        { type: "file", file: "/tmp/a.txt", name: "a.txt" },
      ]),
    ).toMatchObject([
      { type: "reply", data: { id: "1" } },
      { type: "at", data: { qq: "20000" } },
      { type: "text", data: { text: "hi" } },
      { type: "image", data: { file: "/tmp/a.png" } },
      { type: "file", data: { file: "/tmp/a.txt", name: "a.txt" } },
    ]);
  });
});
