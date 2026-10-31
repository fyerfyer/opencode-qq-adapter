import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  PluginChat,
  PluginCommandContext,
  PluginContext,
  PluginMessage,
} from "@opencode-qq/plugin-sdk";
import { TranscriptStore } from "@opencode-qq/memory";
import { BindingStore, type BindingRecord } from "./bindings.js";
import { type DeliveryOptions } from "./delivery.js";
import { JevEmotionJudge } from "./jev.js";
import { MemoryDocumentStore } from "./memory-document.js";
import { MemoryService } from "./memory-service.js";
import { type RoleplayOptions } from "./options.js";
import { getPersona, type PersonaRecord } from "./persona.js";
import { loadStickerCatalog, type StickerCatalog } from "./stickers.js";
import {
  parseStoredWorldbook,
  type WorldbookEffectState,
  type WorldbookEntry,
} from "./worldbook.js";

export interface BoundPersona {
  binding: BindingRecord;
  persona: PersonaRecord;
}

export interface RoleplayRuntime {
  options: RoleplayOptions;
  personasDir: string;
  stickerRoot: string;
  memoryRoot: string;
  databasePath: string;
  transcript: TranscriptStore;
  bindings: BindingStore;
  documents: MemoryDocumentStore;
  memory: MemoryService;
  jev: JevEmotionJudge | null;
  worldbookCache: Map<string, WorldbookEntry[]>;
  stickerCache: Map<string, StickerCatalog>;
  lastStickers: Map<string, string>;
  lastStickerAt: Map<string, number>;
  worldbookEffects: Map<string, Map<string, WorldbookEffectState>>;
  logger: PluginContext<RoleplayOptions>["logger"];
  sessions: PluginContext<RoleplayOptions>["sessions"];
  stickerCatalogFor(persona: PersonaRecord | string): Promise<StickerCatalog>;
  worldbookFor(persona: PersonaRecord): Promise<WorldbookEntry[]>;
  boundPersona(chatKey: string): Promise<BoundPersona | null>;
  activePersona(chatKey: string): Promise<BoundPersona | null>;
  activate(command: PluginCommandContext, persona: PersonaRecord, sendGreeting: boolean): Promise<string>;
  deliverMemory(command: PluginCommandContext, personaId: string, text: string): Promise<string>;
  dispose(): Promise<void>;
}

export function expandPath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return isAbsolute(input) ? input : resolve(input);
}

export function deliveryOptions(options: RoleplayOptions): DeliveryOptions {
  return {
    maxSegments: options.maxSegments,
    maxChars: options.maxCharsPerSegment,
    delayPerCharMs: options.delayPerCharMs,
    maxDelayMs: options.maxDelayMs,
  };
}

export function createRoleplayRuntime(
  context: PluginContext<RoleplayOptions>,
): RoleplayRuntime {
  const options = context.config;
  const personasDir =
    options.personasDir !== null ? expandPath(options.personasDir) : join(context.dataDir, "personas");
  const stickerRoot = join(context.dataDir, "stickers");
  const memoryRoot = join(context.dataDir, "memory");
  const databasePath = join(context.dataDir, "roleplay.db");
  const transcript = new TranscriptStore(databasePath);
  const bindings = new BindingStore(databasePath);
  const documents = new MemoryDocumentStore({
    root: memoryRoot,
    historyLimit: options.memoryHistoryLimit,
  });
  const memory = new MemoryService({
    transcript,
    documents,
    agent: context.agent,
    logger: context.logger,
    options,
  });
  const worldbookCache = new Map<string, WorldbookEntry[]>();
  const worldbookEffects = new Map<string, Map<string, WorldbookEffectState>>();
  const stickerCache = new Map<string, StickerCatalog>();
  const lastStickers = new Map<string, string>();
  const lastStickerAt = new Map<string, number>();
  const jevKey = process.env[options.jevApiKeyEnv]?.trim() ?? "";
  const jev =
    options.stickerEnabled &&
    (options.stickerJudge === "jev" || options.stickerJudge === "hybrid") &&
    jevKey.length > 0
      ? new JevEmotionJudge({
          baseUrl: options.jevBaseUrl,
          endpoint: options.jevEndpoint,
          apiKey: jevKey,
          model: options.jevModel,
          timeoutMs: options.jevTimeoutMs,
        })
      : null;
  if (
    options.stickerEnabled &&
    (options.stickerJudge === "jev" || options.stickerJudge === "hybrid") &&
    jev === null
  ) {
    context.logger.warn(
      { env: options.jevApiKeyEnv },
      "Sticker judge is enabled but the API key env var is missing; falling back to tags",
    );
  }
  let disposed = false;

  const stickerCatalogFor = async (
    persona: PersonaRecord | string,
  ): Promise<StickerCatalog> => {
    const personaId = typeof persona === "string" ? persona : persona.id;
    const cached = stickerCache.get(personaId);
    if (cached !== undefined) return cached;
    const catalog = await loadStickerCatalog(stickerRoot, personaId);
    stickerCache.set(personaId, catalog);
    return catalog;
  };

  const worldbookFor = async (persona: PersonaRecord): Promise<WorldbookEntry[]> => {
    const cached = worldbookCache.get(persona.id);
    if (cached !== undefined) return cached;
    const raw = await readFile(join(persona.dir, "worldbook.json"), "utf8").catch(() => null);
    if (raw === null) {
      worldbookCache.set(persona.id, []);
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      const entries = parseStoredWorldbook(parsed);
      worldbookCache.set(persona.id, entries);
      return entries;
    } catch {
      worldbookCache.set(persona.id, []);
      return [];
    }
  };

  const boundPersona = async (chatKey: string): Promise<BoundPersona | null> => {
    const binding = bindings.get(chatKey);
    if (binding === null) return null;
    const persona = await getPersona(personasDir, binding.namespace);
    if (persona === null) return null;
    return { binding, persona };
  };

  const activePersona = async (chatKey: string): Promise<BoundPersona | null> => {
    const bound = await boundPersona(chatKey);
    if (bound === null || !bound.binding.enabled) return null;
    return bound;
  };

  const activate = async (
    command: PluginCommandContext,
    persona: PersonaRecord,
    sendGreeting: boolean,
  ): Promise<string> => {
    const chatKey = command.message.chat.chatKey;
    const existing = bindings.get(chatKey);
    const conversation = context.sessions.get(chatKey) ?? command.conversation;
    const alreadyOnProject = conversation?.projectId === options.projectId;
    const previousProjectId =
      existing?.previousProjectId ??
      (conversation !== null && conversation !== undefined && conversation.projectId !== options.projectId
        ? conversation.projectId
        : options.fallbackProject);

    if (!alreadyOnProject) {
      const switched = context.sessions.setProject(chatKey, options.projectId, command.actor);
      if (!switched.ok) return switched.reason ?? "切换项目失败。";
    }
    const needsReset =
      existing === null ||
      !existing.enabled ||
      existing.namespace !== persona.id ||
      !alreadyOnProject;
    if (needsReset) {
      const reset = context.sessions.reset(chatKey, command.actor);
      if (!reset.ok) return reset.reason ?? "重置会话失败。";
    }

    bindings.set({
      chatKey,
      namespace: persona.id,
      previousProjectId,
      enabled: true,
      updatedAt: Date.now(),
    });

    if (sendGreeting && needsReset) {
      const greeting = persona.firstMes.trim();
      if (greeting.length > 0) {
        transcript.addMessage({
          namespace: persona.id,
          chatKey,
          scope: chatKey,
          role: "assistant",
          speaker: persona.name,
          text: greeting,
          ts: Date.now(),
        });
        return greeting;
      }
    }
    return `角色扮演已开启：${persona.name}（${persona.id}）`;
  };

  const deliverMemory = async (
    command: PluginCommandContext,
    personaId: string,
    text: string,
  ): Promise<string> => {
    if (command.message.chat.type !== "group") return text;
    try {
      await context.messages.send(privateChatFor(command.message), text);
      return "已私聊你。";
    } catch (error) {
      context.logger.warn(
        { err: error, personaId, chatKey: command.message.chat.chatKey },
        "Failed to deliver roleplay memory by private message",
      );
      return "无法私聊发送记忆详情，请先添加我为好友。";
    }
  };

  return {
    options,
    personasDir,
    stickerRoot,
    memoryRoot,
    databasePath,
    transcript,
    bindings,
    documents,
    memory,
    jev,
    worldbookCache,
    stickerCache,
    lastStickers,
    lastStickerAt,
    worldbookEffects,
    logger: context.logger,
    sessions: context.sessions,
    stickerCatalogFor,
    worldbookFor,
    boundPersona,
    activePersona,
    activate,
    deliverMemory,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await memory.dispose();
      transcript.close();
      bindings.close();
    },
  };
}

export function privateChatFor(message: PluginMessage): PluginChat {
  return {
    type: "private",
    userId: message.userId,
    chatKey: `private:${message.userId}`,
  };
}
