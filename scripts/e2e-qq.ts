#!/usr/bin/env tsx
/**
 * Real QQ end-to-end smoke test.
 *
 * Prerequisites:
 *   - bridge is running and connected to the bot account's NapCat
 *   - a second QQ account (or NapCat instance) can send private messages to the bot
 *   - both NapCat HTTP APIs are reachable
 *
 * Environment:
 *   QQ_BOT_HTTP          default http://127.0.0.1:13000
 *   QQ_BOT_TOKEN         OneBot token for the bot account
 *   QQ_PEER_HTTP         default http://127.0.0.1:13100
 *   QQ_PEER_TOKEN        OneBot token for the peer account
 *   QQ_BOT_ID            bot QQ number
 *   QQ_PEER_ID           peer QQ number
 *   QQ_E2E_PROMPT        optional prompt (default: 请只回复：qq-opencode-ok)
 *   QQ_E2E_PROJECT       project id used by !use (default: demo)
 *   QQ_E2E_STOP          set to 1 to also verify !stop
 *   QQ_E2E_APPROVAL      set to 1 to verify the QQ approval flow
 */

interface HistoryMessage {
  time: number;
  post_type?: string;
  user_id: number;
  raw_message?: string;
}

const env = process.env;

const botHttp = env.QQ_BOT_HTTP ?? "http://127.0.0.1:13000";
const peerHttp = env.QQ_PEER_HTTP ?? "http://127.0.0.1:13100";
const botToken = required("QQ_BOT_TOKEN");
const peerToken = required("QQ_PEER_TOKEN");
const botId = Number(required("QQ_BOT_ID"));
const peerId = Number(required("QQ_PEER_ID"));
const prompt = env.QQ_E2E_PROMPT ?? "请只回复：qq-opencode-ok";
const project = env.QQ_E2E_PROJECT ?? "demo";

async function main(): Promise<void> {
  const started = Math.floor(Date.now() / 1000) - 1;

  await send("!ping");
  const pong = await waitForReply(started, (raw) => raw.endsWith("pong"));
  console.log(`✓ !ping -> ${pong}`);

  await send(`!use ${project}`);
  await delay(500);
  await send("!new");
  await delay(500);
  await send(prompt);
  const answer = await waitForReply(started, (raw) => raw.includes("qq-opencode-ok"), 120);
  console.log(`✓ prompt -> ${answer.slice(0, 200)}`);

  if (env.QQ_E2E_STOP === "1") {
    await send("请用至少 800 字详细解释 TCP 三次握手和四次挥手。");
    await delay(1000);
    await send("!stop");
    const stopped = await waitForReply(started, (raw) => raw.includes("已请求中断"), 30);
    console.log(`✓ !stop -> ${stopped}`);
  }

  if (env.QQ_E2E_APPROVAL === "1") {
    await send("!new");
    await delay(500);
    await send(
      "请必须使用 shell 工具执行命令 `echo qq-approval-ok`，然后只回复命令输出，不要猜测结果。",
    );
    const asked = await waitForReply(started, (raw) => raw.includes("需要审批"), 90);
    console.log(`✓ approval requested -> ${asked.split("\n")[0]}`);

    await send("1");
    const approved = await waitForReply(started, (raw) => raw.includes("已批准"), 30);
    console.log(`✓ approval reply -> ${approved}`);

    const approvedAnswer = await waitForReply(
      started,
      (raw) => raw.includes("qq-approval-ok") && !raw.includes("需要审批"),
      120,
    );
    console.log(`✓ approved command -> ${approvedAnswer.slice(0, 200)}`);
  }

  console.log("QQ E2E passed");
}

async function send(text: string): Promise<void> {
  const response = await fetch(`${peerHttp}/send_private_msg`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${peerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      user_id: botId,
      message: [{ type: "text", data: { text } }],
    }),
  });
  const body = (await response.json()) as { status: string; retcode: number; wording?: string };
  if (body.status !== "ok" || body.retcode !== 0) {
    throw new Error(`Failed to send QQ message: ${body.wording ?? JSON.stringify(body)}`);
  }
}

async function waitForReply(
  started: number,
  predicate: (raw: string) => boolean,
  timeoutSec = 60,
): Promise<string> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const messages = await history();
    for (const message of messages) {
      if (message.time < started) continue;
      if (message.post_type !== "message_sent" && message.user_id !== botId) continue;
      const raw = message.raw_message ?? "";
      if (predicate(raw)) return raw;
    }
    await delay(1000);
  }
  throw new Error(`Timed out after ${timeoutSec}s waiting for a QQ reply`);
}

async function history(): Promise<HistoryMessage[]> {
  const response = await fetch(`${botHttp}/get_friend_msg_history`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${botToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ user_id: peerId, count: 20 }),
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
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
