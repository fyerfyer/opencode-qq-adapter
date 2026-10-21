#!/usr/bin/env tsx
/**
 * Real QQ media end-to-end test.
 *
 * Prerequisites:
 *   - bridge is running and connected to the bot account's NapCat
 *   - a peer QQ account can send private messages to the bot
 *   - OpenCode has the qq_send_image V2 plugin installed and can see images
 *
 * Environment:
 *   QQ_BOT_HTTP / QQ_BOT_TOKEN / QQ_BOT_ID
 *   QQ_PEER_HTTP / QQ_PEER_TOKEN / QQ_PEER_ID
 *   QQ_E2E_CHART   path (in the bridge workspace) used for outbound image test
 *   QQ_E2E_IMAGE   local image sent to the bot (default tests/fixtures/red.png)
 *   QQ_E2E_MODEL   optional hint for the inbound prompt
 */
import { readFile } from "node:fs/promises";

interface HistoryMessage {
  time: number;
  post_type?: string;
  user_id: number;
  raw_message?: string;
  message?: Array<{ type: string; data?: Record<string, unknown> }>;
}

const env = process.env;
const botHttp = env.QQ_BOT_HTTP ?? "http://127.0.0.1:13000";
const peerHttp = env.QQ_PEER_HTTP ?? "http://127.0.0.1:13100";
const botToken = required("QQ_BOT_TOKEN");
const peerToken = required("QQ_PEER_TOKEN");
const botId = Number(required("QQ_BOT_ID"));
const peerId = Number(required("QQ_PEER_ID"));
const chartPath = env.QQ_E2E_CHART ?? "var/e2e-chart.png";
const imagePath = env.QQ_E2E_IMAGE ?? "tests/fixtures/red.png";

async function main(): Promise<void> {
  const started = Math.floor(Date.now() / 1000) - 1;
  await send("!use demo");
  await delay(500);
  await send("!new");
  await delay(500);

  await sendImage(
    await readFile(imagePath),
    "这张图片的主体背景是什么颜色？只回答颜色，不要使用 shell 工具。",
  );
  const vision = await waitForBot(
    started,
    (message) => {
      const text = messageText(message);
      return /red|红色|红/i.test(text) && !text.includes("需要审批");
    },
    180,
  );
  console.log(`✓ inbound image -> ${messageText(vision).slice(0, 200)}`);

  const chart = await readFile(chartPath);
  if (chart.length === 0) throw new Error(`${chartPath} is empty`);
  await send("!new");
  await delay(500);
  await send(
    `请调用 qq_send_image 工具发送 ${chartPath}，caption 写 media-e2e。` +
      "不要使用 shell。发送成功后只回复 done。",
  );
  const outbound = await waitForBot(
    started,
    (message) => {
      const hasImage = message.message?.some((segment) => segment.type === "image") ?? false;
      return hasImage || messageText(message).includes("media-e2e");
    },
    180,
  );
  console.log(`✓ outbound image -> ${messageText(outbound).slice(0, 200) || "[image]"}`);
  console.log("QQ media E2E passed");
}

async function send(text: string): Promise<void> {
  await action(peerHttp, peerToken, "send_private_msg", {
    user_id: botId,
    message: [{ type: "text", data: { text } }],
  });
}

async function sendImage(buffer: Buffer, text: string): Promise<void> {
  await action(peerHttp, peerToken, "send_private_msg", {
    user_id: botId,
    message: [
      {
        type: "image",
        data: { file: `base64://${buffer.toString("base64")}`, summary: "red.png" },
      },
      { type: "text", data: { text } },
    ],
  });
}

async function action(
  baseUrl: string,
  token: string,
  name: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${baseUrl}/${name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { status: string; retcode: number; wording?: string };
  if (payload.status !== "ok") {
    throw new Error(`${name} failed: ${payload.wording ?? JSON.stringify(payload)}`);
  }
}

async function waitForBot(
  started: number,
  predicate: (message: HistoryMessage) => boolean,
  timeoutSec: number,
): Promise<HistoryMessage> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    for (const message of await history()) {
      if (message.time < started) continue;
      if (message.post_type !== "message_sent" && message.user_id !== botId) continue;
      if (predicate(message)) return message;
    }
    await delay(1000);
  }
  throw new Error(`Timed out after ${timeoutSec}s waiting for a QQ media reply`);
}

function messageText(message: HistoryMessage): string {
  return (
    message.message
      ?.filter((segment) => segment.type === "text")
      .map((segment) => String(segment.data?.text ?? ""))
      .join("") ??
    message.raw_message ??
    ""
  );
}

async function history(): Promise<HistoryMessage[]> {
  const response = await fetch(`${botHttp}/get_friend_msg_history`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${botToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ user_id: peerId, count: 30 }),
  });
  const body = (await response.json()) as {
    status: string;
    data?: { messages?: HistoryMessage[] };
    wording?: string;
  };
  if (body.status !== "ok") {
    throw new Error(`Failed to read QQ history: ${body.wording ?? JSON.stringify(body)}`);
  }
  return body.data?.messages ?? [];
}

function required(name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`Missing environment variable ${name}`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
