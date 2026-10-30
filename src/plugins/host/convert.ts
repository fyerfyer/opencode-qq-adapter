import type { PluginConfig } from "../../config/schema.js";
import type { IncomingMessage } from "../../domain/message.js";
import type { AgentMessage } from "../../ports/agent.js";
import type { LoadedPluginModule } from "../manifest.js";
import type {
  PluginAgentResult,
  PluginChat,
  PluginCommandDefinition,
  PluginMessage,
  PluginPromptPatch,
  PluginRole,
} from "../sdk.js";
import type { PluginInstance } from "./types.js";

const COMMAND_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export const ROLES: readonly PluginRole[] = ["owner", "admin", "member"];
export const CHAT_TYPES = ["private", "group"] as const;

export function parseOptions(
  loaded: LoadedPluginModule,
  options: Record<string, unknown>,
): unknown {
  if (loaded.definition.options === undefined) return options;
  try {
    return loaded.definition.options.parse(options);
  } catch (error) {
    throw new Error(
      `invalid options for plugin ${loaded.manifest.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function requireCapability(instance: PluginInstance, capability: string): void {
  const capabilities: readonly string[] = instance.manifest?.capabilities ?? [];
  if (!capabilities.includes(capability)) {
    throw new Error(
      `plugin ${instance.id} must declare capability '${capability}' in its manifest`,
    );
  }
}

export function validateCommand(command: PluginCommandDefinition): string[] {
  if (!isRecord(command)) throw new Error("command definition must be an object");
  if (typeof command.name !== "string" || !COMMAND_NAME.test(command.name)) {
    throw new Error("command name must match /^[a-z][a-z0-9_-]{0,31}$/");
  }
  if (typeof command.handler !== "function") {
    throw new Error(`command '${command.name}' must provide a handler function`);
  }
  const aliases = command.aliases ?? [];
  if (!Array.isArray(aliases))
    throw new Error(`command '${command.name}' aliases must be an array`);
  const names = [command.name, ...aliases].map((name) => {
    if (typeof name !== "string" || !COMMAND_NAME.test(name)) {
      throw new Error(`invalid command/alias name: ${String(name)}`);
    }
    return name.toLowerCase();
  });
  if (new Set(names).size !== names.length) {
    throw new Error(`command '${command.name}' has duplicate names/aliases`);
  }
  if (command.roles !== undefined) {
    if (!Array.isArray(command.roles) || command.roles.length === 0) {
      throw new Error(`command '${command.name}' roles must be a non-empty array`);
    }
    for (const role of command.roles) {
      if (!ROLES.includes(role)) throw new Error(`invalid role: ${String(role)}`);
    }
  }
  if (command.chats !== undefined) {
    if (!Array.isArray(command.chats) || command.chats.length === 0) {
      throw new Error(`command '${command.name}' chats must be a non-empty array`);
    }
    for (const type of command.chats) {
      if (!CHAT_TYPES.includes(type)) throw new Error(`invalid chat type: ${String(type)}`);
    }
  }
  return names;
}

export function normalizeReplyText(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= 8000 ? text : null;
}

export function isPromptPatch(value: unknown): value is PluginPromptPatch {
  return isRecord(value);
}

export function toPluginChat(chat: {
  type: "private" | "group";
  userId: number;
  groupId?: number;
  chatKey: string;
}): PluginChat {
  return {
    type: chat.type,
    userId: chat.userId,
    ...(chat.groupId !== undefined ? { groupId: chat.groupId } : {}),
    chatKey: chat.chatKey,
  };
}

export function toPluginMessage(message: IncomingMessage): PluginMessage {
  return {
    id: message.id,
    chat: toPluginChat(message.chat),
    userId: message.userId,
    senderName: message.senderName,
    text: message.text,
    images: message.images.map((image) => ({ ...image })),
    ...(message.replyToId !== undefined ? { replyToId: message.replyToId } : {}),
    mentionsBot: message.mentionsBot,
    receivedAt: message.receivedAt,
  };
}

export function sumUtilityUsage(messages: AgentMessage[]): PluginAgentResult["usage"] {
  let cost = 0;
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let found = false;
  for (const message of messages) {
    if (message.cost !== null) {
      cost += message.cost;
      found = true;
    }
    if (message.tokens !== null) {
      tokens.input += message.tokens.input;
      tokens.output += message.tokens.output;
      tokens.reasoning += message.tokens.reasoning;
      tokens.cacheRead += message.tokens.cacheRead;
      tokens.cacheWrite += message.tokens.cacheWrite;
      found = true;
    }
  }
  return found ? { cost, tokens } : null;
}

export function sameSpec(left: PluginConfig, right: PluginConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 240 ? `${message.slice(0, 240)}…` : message;
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
