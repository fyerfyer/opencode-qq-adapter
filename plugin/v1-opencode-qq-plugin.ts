import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Plugin, tool } from "@opencode-ai/plugin";

/**
 * OpenCode V1-compatible plugin. Use this file only with OpenCode 1.x, whose
 * plugin loader expects a function returning a `tool` map. OpenCode V2 should
 * use ../opencode-qq-plugin.ts instead.
 */

const DEFAULT_URL = "http://127.0.0.1:8787";

function bridgeConfig(): { url: string; token: string } {
  const envUrl = process.env.QQ_BRIDGE_INTERNAL_URL;
  const envToken = process.env.QQ_BRIDGE_INTERNAL_TOKEN;
  if (envUrl && envToken) return { url: envUrl, token: envToken };
  const path =
    process.env.QQ_BRIDGE_INTERNAL_CONFIG ??
    join(homedir(), ".config", "opencode", "qq-bridge.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { url?: string; token?: string };
    return {
      url: envUrl ?? parsed.url ?? DEFAULT_URL,
      token: envToken ?? parsed.token ?? "",
    };
  } catch {
    return { url: envUrl ?? DEFAULT_URL, token: envToken ?? "" };
  }
}

async function post(path: string, body: unknown): Promise<{ messageId?: string }> {
  const config = bridgeConfig();
  const url = config.url.replace(/\/+$/, "");
  const token = config.token;
  if (token.length === 0) {
    throw new Error(
      "QQ bridge token is not configured. Set QQ_BRIDGE_INTERNAL_TOKEN or create ~/.config/opencode/qq-bridge.json",
    );
  }
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
    messageId?: string;
  };
  if (!response.ok) {
    throw new Error(payload.message ?? payload.error ?? `bridge returned HTTP ${response.status}`);
  }
  return { ...(payload.messageId ? { messageId: payload.messageId } : {}) };
}

export const QQAdapterPlugin: Plugin = async () => {
  return {
    tool: {
      qq_send_image: tool({
        description:
          "Send an image file back to the QQ conversation that is using this session. " +
          "The path must be inside the current workspace; prefer a relative path. " +
          "Use this when the user asks to see a generated chart, screenshot, or image.",
        args: {
          path: tool.schema
            .string()
            .describe(
              "Image path inside the workspace (relative paths are resolved from the workspace)",
            ),
          caption: tool.schema
            .string()
            .optional()
            .describe("Optional short caption sent after the image"),
        },
        async execute(args, context) {
          const result = await post("/internal/plugin/send-image", {
            sessionId: context.sessionID,
            path: args.path,
            ...(args.caption ? { caption: args.caption } : {}),
          });
          return {
            title: "Image sent to QQ",
            output: `Image sent to the QQ conversation${result.messageId ? ` (message ${result.messageId})` : ""}.`,
          };
        },
      }),
    },
  };
};
