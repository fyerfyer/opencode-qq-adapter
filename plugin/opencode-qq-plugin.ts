/**
 * OpenCode V2 plugin that lets an agent send an image back to the QQ chat that
 * owns the current session.
 *
 * Install by copying/symlinking this file into one of OpenCode's plugin
 * directories (`~/.config/opencode/plugins/` or `.opencode/plugins/`), and set
 * QQ_BRIDGE_INTERNAL_URL / QQ_BRIDGE_INTERNAL_TOKEN in the OpenCode service
 * environment. No imports are required; the plugin only uses the injected
 * `ctx.tool` domain and global `fetch`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_URL = "http://127.0.0.1:8787";

interface BridgeConfig {
  url: string;
  token: string;
}

interface SendImageInput {
  path: string;
  caption?: string;
}

interface ToolExecuteContext {
  sessionID?: string;
  signal?: AbortSignal;
}

/**
 * The OpenCode background service may be launched by the TUI and therefore not
 * inherit a shell environment. Prefer env vars, then fall back to a 0600 local
 * config file so users do not have to restart their whole editor session.
 */
function loadBridgeConfig(): BridgeConfig {
  const envUrl = process.env.QQ_BRIDGE_INTERNAL_URL;
  const envToken = process.env.QQ_BRIDGE_INTERNAL_TOKEN;
  if (envUrl && envToken) return { url: envUrl, token: envToken };

  const configPath =
    process.env.QQ_BRIDGE_INTERNAL_CONFIG ??
    join(homedir(), ".config", "opencode", "qq-bridge.json");
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<BridgeConfig>;
    return {
      url: envUrl ?? parsed.url ?? DEFAULT_URL,
      token: envToken ?? parsed.token ?? "",
    };
  } catch {
    return { url: envUrl ?? DEFAULT_URL, token: envToken ?? "" };
  }
}

async function post(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ messageId?: string }> {
  const config = loadBridgeConfig();
  const url = config.url.replace(/\/+$/, "");
  const token = config.token;
  if (token.length === 0) {
    throw new Error(
      "QQ bridge token is not configured. Set QQ_BRIDGE_INTERNAL_TOKEN or create ~/.config/opencode/qq-bridge.json",
    );
  }
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
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

export default {
  id: "opencode-qq-adapter",
  async setup(ctx: {
    tool: {
      transform(
        callback: (editor: {
          add(tool: {
            name: string;
            description: string;
            input: Record<string, unknown>;
            execute(input: unknown, context: ToolExecuteContext): Promise<{ content: string }>;
          }): void;
        }) => void,
      ): Promise<unknown>;
    };
  }): Promise<void> {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "qq_send_image",
        description:
          "Send an image file back to the QQ conversation that is using this session. " +
          "The path must be inside the current workspace; prefer a relative path. " +
          "Use this when the user asks to see a generated chart, screenshot, or image.",
        input: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Image path inside the workspace (relative paths are resolved from the workspace)",
            },
            caption: {
              type: "string",
              description: "Optional short caption sent after the image",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
        async execute(rawInput, context) {
          const input = rawInput as SendImageInput;
          if (typeof input.path !== "string" || input.path.length === 0) {
            throw new Error("path is required");
          }
          if (typeof context.sessionID !== "string" || context.sessionID.length === 0) {
            throw new Error("OpenCode did not provide a session ID for this tool call");
          }
          const result = await post(
            "/internal/plugin/send-image",
            {
              sessionId: context.sessionID,
              path: input.path,
              ...(typeof input.caption === "string" ? { caption: input.caption } : {}),
            },
            context.signal,
          );
          return {
            content: `Image sent to the QQ conversation${result.messageId ? ` (message ${result.messageId})` : ""}.`,
          };
        },
      });
    });
  },
};
