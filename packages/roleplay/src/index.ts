import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  defineCommand,
  definePlugin,
  type PluginChat,
  type PluginCommandContext,
  type PluginContext,
  type PluginGroupMode,
  type PluginMessage,
  type PluginRunContext,
} from "@opencode-qq/plugin-sdk";
import { installQqRpAgent, installQqRpUtilityAgent } from "./agent.js";
import { registerRoleplayAdmin } from "./admin.js";
import {
  type DeliveryOptions,
  planReplyWithSticker,
} from "./delivery.js";
import { docForPrompt, type MemoryDoc, MemoryDocumentStore } from "./memory-document.js";
import { type MemorySearchResult, MemoryService, type MemoryView } from "./memory-service.js";
import { parseRoleplayOptions, type RoleplayOptions } from "./options.js";
import { JevEmotionJudge } from "./jev.js";
import { getPersona, importCard, listPersonas, type PersonaRecord } from "./persona.js";
import {
  chooseSticker,
  extractEmotionTag,
  listEmotions,
  loadStickerCatalog,
  stickerCount,
  type StickerCatalog,
} from "./stickers.js";
import { buildContextBlock } from "./prompt.js";
import { formatTimestamp } from "./time.js";
import { BindingStore } from "./bindings.js";
import { type MemoryEvent, TranscriptStore } from "./transcript.js";
import {
  formatWorldbookTrace,
  parseStoredWorldbook,
  selectWorldbook,
  selectWorldbookDetailed,
  type WorldbookEntry,
} from "./worldbook.js";

const VERSION = "0.4.0";
const MAX_REMEMBER_CHARS = 200;
const MEMORY_OUTPUT_CHARS = 1800;

function expandPath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return isAbsolute(input) ? input : resolve(input);
}

function roleplayConfigDir(explicit: string | null): string {
  if (explicit !== null) return expandPath(explicit);
  const env = process.env.OPENCODE_CONFIG_DIR;
  if (env !== undefined && env.trim().length > 0) return expandPath(env);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
}

function deliveryOptions(options: RoleplayOptions): DeliveryOptions {
  return {
    maxSegments: options.maxSegments,
    maxChars: options.maxCharsPerSegment,
    delayPerCharMs: options.delayPerCharMs,
    maxDelayMs: options.maxDelayMs,
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

function isSharedGroup(mode: PluginGroupMode | null): boolean {
  return mode === "shared" || mode === "readonly";
}

function canManageGroup(command: PluginCommandContext): boolean {
  if (command.message.chat.type !== "group") return true;
  if (!isSharedGroup(command.groupMode)) return true;
  return command.actor.role === "owner" || command.actor.role === "admin";
}

function canViewAllActors(command: PluginCommandContext): boolean {
  return (
    command.message.chat.type === "group" &&
    isSharedGroup(command.groupMode) &&
    canManageGroup(command)
  );
}

function privateChatFor(message: PluginMessage): PluginChat {
  return {
    type: "private",
    userId: message.userId,
    chatKey: `private:${message.userId}`,
  };
}

function capText(text: string, maxChars = MEMORY_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatDoc(title: string, doc: MemoryDoc): string {
  const content = doc.content.trim().length > 0 ? docForPrompt(doc.content, 4000) : "";
  return `${title}\n${content.length > 0 ? content : "（空）"}`;
}

function formatMemoryView(personaName: string, view: MemoryView): string {
  const lines: string[] = [`角色：${personaName}`];
  if (view.shared) {
    lines.push(formatDoc("[群聊场景]", view.scene ?? emptyDoc()));
    if (view.allUsers.length > 0) {
      lines.push("[群成员记忆]");
      for (const doc of view.allUsers) {
        const id = basename(doc.path, ".md");
        lines.push(formatDoc(`群友 ${id}`, doc));
      }
    } else {
      lines.push(formatDoc("[我的记忆]", view.user));
    }
  } else {
    lines.push(formatDoc("[长期记忆]", view.user));
  }
  lines.push(`原文：${view.rawCount} 条`);
  if (view.lastEvent !== null) {
    lines.push(
      `最近变更：${formatTimestamp(view.lastEvent.createdAt)} · ${view.lastEvent.summary}`,
    );
  }
  lines.push(
    "用法：!memory search 关键词 | !memory diff | !memory history | !memory refresh | !remember 内容 | !forget confirm",
  );
  return capText(lines.join("\n"));
}

function emptyDoc(): MemoryDoc {
  return { path: "", content: "", exists: false, updatedAt: null };
}

function formatHistory(events: MemoryEvent[]): string {
  if (events.length === 0) return "还没有记忆变更。";
  return capText(
    [
      `最近记忆变更（${events.length}）：`,
      ...events.map(
        (event) =>
          `- [${formatTimestamp(event.createdAt)}] ${event.action} · ${event.summary}`,
      ),
    ].join("\n"),
  );
}

function formatDiff(event: MemoryEvent | null): string {
  if (event === null) return "还没有记忆变更。";
  const lines = [
    `最近变更：${formatTimestamp(event.createdAt)} · ${event.action}`,
    event.summary,
  ];
  const detail = event.detail;
  if (detail !== null) {
    lines.push(...formatOperations("用户", detail.user));
    lines.push(...formatOperations("群聊", detail.scene));
  }
  if (lines.length === 2) lines.push("（没有 section 级变更记录）");
  return capText(lines.join("\n"));
}

function formatOperations(label: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const lines: string[] = [`${label}操作：`];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const section = typeof record.section === "string" ? record.section : "?";
    const op = typeof record.op === "string" ? record.op : "?";
    const reason = typeof record.reason === "string" ? `（${record.reason}）` : "";
    lines.push(`- ${section} · ${op}${reason}`);
  }
  return lines;
}

function formatSearch(result: MemorySearchResult): string {
  const lines: string[] = [];
  for (const doc of result.docs) {
    lines.push(`- [${doc.source} · ${doc.section}] ${doc.line}`);
  }
  if (result.messages.length > 0) {
    lines.push(
      "[原文]",
      ...result.messages.map(
        (message) =>
          `- [${formatTimestamp(message.ts)}] ${message.role === "user" ? message.speaker : "你"}：${message.text}`,
      ),
    );
  }
  return lines.length > 0 ? capText(lines.join("\n")) : "没有匹配的记忆。";
}

export default definePlugin<RoleplayOptions>({
  options: { parse: parseRoleplayOptions },
  setup(context) {
    const options = context.config;
    const personasDir =
      options.personasDir !== null
        ? expandPath(options.personasDir)
        : join(context.dataDir, "personas");
    const transcript = new TranscriptStore(join(context.dataDir, "roleplay.db"));
    const bindings = new BindingStore(join(context.dataDir, "roleplay.db"));
    const documents = new MemoryDocumentStore({
      root: join(context.dataDir, "memory"),
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
    const stickerRoot = join(context.dataDir, "stickers");
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

    const stickerCatalogFor = async (persona: PersonaRecord): Promise<StickerCatalog> => {
      const cached = stickerCache.get(persona.id);
      if (cached !== undefined) return cached;
      const catalog = await loadStickerCatalog(stickerRoot, persona.id);
      stickerCache.set(persona.id, catalog);
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

    const boundPersona = async (chatKey: string) => {
      const binding = bindings.get(chatKey);
      if (binding === null) return null;
      const persona = await getPersona(personasDir, binding.namespace);
      if (persona === null) return null;
      return { binding, persona };
    };

    const activePersona = async (chatKey: string) => {
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
      if (isSharedGroup(command.groupMode) && !canManageGroup(command)) {
        return "shared 群中只有 owner/admin 可以查看记忆。";
      }
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

    context.commands.register(
      defineCommand({
        name: "card",
        description: "导入 Character Card V2/V3",
        usage: "card import 文件路径 [id]",
        chats: ["private"],
        roles: ["owner"],
        async handler(command) {
          const sub = command.args[0]?.toLowerCase();
          const source = command.args[1];
          if (sub !== "import" || source === undefined) {
            return "用法：!card import 文件路径 [id]";
          }
          try {
            const result = await importCard({
              sourcePath: expandPath(source),
              personasDir,
              stickerRoot,
              ...(command.args[2] !== undefined ? { id: command.args[2] } : {}),
            });
            worldbookCache.set(result.persona.id, result.worldbook);
            stickerCache.delete(result.persona.id);
            return [
              `已导入角色：${result.persona.name}（${result.persona.id}）`,
              `世界书：${result.worldbook.length} 条`,
              `表情素材：${result.stickerCount} 张`,
              `目录：${result.persona.dir}`,
              `使用 !persona use ${result.persona.id} 激活。`,
            ].join("\n");
          } catch (error) {
            return `导入失败：${errorMessage(error)}`;
          }
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "persona",
        description: "列出、查看或使用角色卡",
        usage: "persona [list|info|use] [id]",
        chats: ["private", "group"],
        allowGroupShared: true,
        async handler(command) {
          const sub = command.args[0]?.toLowerCase() ?? "list";
          const chatKey = command.message.chat.chatKey;
          const binding = bindings.get(chatKey);

          if (sub === "list") {
            const personas = await listPersonas(personasDir);
            if (personas.length === 0) return "还没有角色卡。发送 !card import 文件路径 导入。";
            return [
              `角色卡（${personas.length}）：`,
              ...personas.map(
                (persona) =>
                  `- ${persona.id} · ${persona.name}${binding?.namespace === persona.id ? "（当前）" : ""}`,
              ),
              "使用 !persona use 角色ID 切换。",
            ].join("\n");
          }

          const id = command.args[1] ?? binding?.namespace;
          if (id === undefined) return "用法：!persona use 角色ID";
          const persona = await getPersona(personasDir, id);
          if (persona === null) return `找不到角色：${id}`;

          if (sub === "info") {
            const worldbook = await worldbookFor(persona);
            const stickers = await stickerCatalogFor(persona);
            const emotions = listEmotions(stickers);
            const view = await memory.view({
              personaId: persona.id,
              scope: chatKey,
              actorQq: command.message.userId,
              allActors: canViewAllActors(command),
            });
            const userChars = view.user.content.trim().length;
            const sceneChars = view.scene?.content.trim().length ?? 0;
            return [
              `角色：${persona.name}（${persona.id}）`,
              `开场白：${persona.firstMes || "（无）"}`,
              `世界书：${worldbook.length} 条`,
              `表情：${stickerCount(stickers)} 张${emotions.length > 0 ? `（${emotions.join("、")}）` : ""}`,
              `记忆：用户文档 ${userChars} 字 · 场景文档 ${sceneChars} 字 · 原文 ${view.rawCount} 条`,
              `目录：${persona.dir}`,
            ].join("\n");
          }

          if (sub === "use") {
            if (!canManageGroup(command)) {
              return "shared 群中只有 owner/admin 可以切换角色。";
            }
            return await activate(command, persona, true);
          }
          return "用法：!persona list | !persona info [id] | !persona use 角色ID";
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "sticker",
        description: "查看或测试当前角色的表情素材",
        usage: "sticker [list|reload] | sticker test 情绪",
        chats: ["private"],
        roles: ["owner"],
        async handler(command) {
          const sub = command.args[0]?.toLowerCase() ?? "list";
          const chatKey = command.message.chat.chatKey;
          const active = await boundPersona(chatKey);
          if (active === null) return "还没有绑定角色。发送 !persona use 角色ID。";
          if (sub === "reload") {
            stickerCache.delete(active.persona.id);
            return "表情素材缓存已刷新。";
          }
          const catalog = await stickerCatalogFor(active.persona);
          const emotions = listEmotions(catalog);
          if (sub === "test") {
            const emotion = command.args[1]?.toLowerCase();
            if (emotion === undefined) return "用法：!sticker test 情绪";
            const path = chooseSticker(
              catalog,
              emotion,
              `sticker-test:${active.persona.id}:${chatKey}`,
              lastStickers,
            );
            if (path === null) return `没有 ${emotion} 的表情素材。`;
            const sent = await command.sendImage({ path, caption: `sticker:${emotion}` });
            return `已发送 ${emotion}（${sent.messageId}）。`;
          }
          if (sub !== "list") return "用法：!sticker list | !sticker reload | !sticker test 情绪";
          if (emotions.length === 0) {
            return "当前角色没有表情素材。放到 dataDir/stickers/角色ID/情绪/ 后执行 !sticker reload。";
          }
          return [
            `表情素材（${stickerCount(catalog)} 张）：`,
            ...emotions.map(
              (emotion) => `- ${emotion}：${catalog.emotions.get(emotion)?.length ?? 0} 张`,
            ),
          ].join("\n");
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "worldbook",
        description: "调试世界书关键词、递归和预算",
        usage: "worldbook check 文本",
        chats: ["private", "group"],
        allowGroupShared: true,
        async handler(command) {
          const sub = command.args[0]?.toLowerCase();
          const text = command.args.slice(1).join(" ").trim();
          if (sub !== "check" || text.length === 0) {
            return "用法：!worldbook check 文本";
          }
          const chatKey = command.message.chat.chatKey;
          const active = await boundPersona(chatKey);
          if (active === null) return "还没有绑定角色。发送 !persona use 角色ID。";
          const recent = transcript.recent(
            chatKey,
            options.worldbookScanDepth,
            active.persona.id,
          );
          const trace = selectWorldbookDetailed(
            await worldbookFor(active.persona),
            {
              currentText: text,
              recentTexts: recent.map((row) => row.text),
            },
            {
              scanDepth: options.worldbookScanDepth,
              maxEntries: options.worldbookMaxEntries,
              maxChars: options.worldbookMaxChars,
              recursionSteps: options.worldbookRecursionSteps,
              matchWholeWords: options.worldbookMatchWholeWords,
            },
          );
          const output = capText(
            formatWorldbookTrace(active.persona.name, text, trace),
          );
          return deliverMemory(command, active.persona.id, output);
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "rp",
        description: "查看、开启或关闭角色扮演",
        usage: "rp [on|off|status]",
        chats: ["private", "group"],
        allowGroupShared: true,
        async handler(command) {
          const sub = command.args[0]?.toLowerCase() ?? "status";
          const chatKey = command.message.chat.chatKey;
          const binding = bindings.get(chatKey);

          if (sub === "status") {
            if (binding === null) return "角色扮演未配置。发送 !persona list 查看角色卡。";
            const persona = await getPersona(personasDir, binding.namespace);
            return [
              `状态：${binding.enabled ? "开启" : "关闭"}`,
              `角色：${persona?.name ?? binding.namespace}`,
              `项目：${options.projectId}`,
              `会话：${(context.sessions.get(chatKey) ?? command.conversation)?.sessionId ?? "尚未创建"}`,
            ].join("\n");
          }

          if (sub === "off") {
            if (!canManageGroup(command)) {
              return "shared 群中只有 owner/admin 可以关闭角色扮演。";
            }
            if (binding === null) return "当前没有绑定角色。";
            bindings.set({ ...binding, enabled: false, updatedAt: Date.now() });
            const restoreTo = binding.previousProjectId ?? options.fallbackProject;
            if (restoreTo === null) {
              context.sessions.reset(chatKey, command.actor);
              return "角色扮演已关闭。当前没有可恢复的项目，请发送 !use 项目 选择 coding 项目。";
            }
            const restored = context.sessions.setProject(chatKey, restoreTo, command.actor);
            if (!restored.ok) {
              return `已关闭角色扮演，但恢复原项目失败：${restored.reason ?? "未知原因"}`;
            }
            context.sessions.reset(chatKey, command.actor);
            return "角色扮演已关闭。下次发送 !persona use 角色ID 可以重新开启。";
          }

          if (sub === "on") {
            if (!canManageGroup(command)) {
              return "shared 群中只有 owner/admin 可以开启角色扮演。";
            }
            if (binding === null) {
              if (options.defaultPersona === null) {
                return "请先发送 !persona use 角色ID 选择角色。";
              }
              const fallback = await getPersona(personasDir, options.defaultPersona);
              if (fallback === null) {
                return `默认角色卡不存在：${options.defaultPersona}`;
              }
              return await activate(command, fallback, true);
            }
            const persona = await getPersona(personasDir, binding.namespace);
            if (persona === null) return `角色卡已丢失：${binding.namespace}`;
            return await activate(command, persona, true);
          }
          return "用法：!rp on | !rp off | !rp status";
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "memory",
        description: "查看、搜索或整理当前角色的记忆",
        usage: "memory [search 关键词|refresh|history|diff]",
        chats: ["private", "group"],
        allowGroupShared: true,
        async handler(command) {
          const chatKey = command.message.chat.chatKey;
          const active = await boundPersona(chatKey);
          if (active === null) return "还没有绑定角色。发送 !persona use 角色ID。";
          const sub = command.args[0]?.toLowerCase();

          if (sub === "refresh") {
            if (command.message.chat.type === "group") {
              return "请在私聊中使用 !memory refresh。";
            }
            await command.reply("正在整理记忆…");
            const result = await memory.refresh({
              personaId: active.persona.id,
              personaName: active.persona.name,
              chatKey,
              scope: chatKey,
              actorQq: command.message.userId,
              senderName: command.message.senderName,
            });
            if (!result.enabled) return "记忆整理未启用。";
            if (result.cooldown) return "刚整理过，请稍后再试。";
            if (result.failed) return `整理失败：${result.summary}`;
            return result.changed
              ? `整理完成：${result.summary}`
              : "整理完成：没有新的记忆变化。";
          }

          if (command.message.chat.type === "group" && isSharedGroup(command.groupMode) && !canManageGroup(command)) {
            return "shared 群中只有 owner/admin 可以查看记忆。";
          }

          if (sub === "history") {
            const events = memory.history({
              personaId: active.persona.id,
              scope: chatKey,
              limit: 10,
            });
            return deliverMemory(command, active.persona.id, formatHistory(events));
          }

          if (sub === "diff") {
            const event = memory.lastEvent({ personaId: active.persona.id, scope: chatKey });
            return deliverMemory(command, active.persona.id, formatDiff(event));
          }

          if (sub === "search") {
            const query = command.args.slice(1).join(" ").trim();
            if (query.length === 0) return "用法：!memory search 关键词";
            const result = await memory.search({
              personaId: active.persona.id,
              scope: chatKey,
              actorQq: command.message.userId,
              query,
              allActors: canViewAllActors(command),
              limit: 5,
            });
            return deliverMemory(
              command,
              active.persona.id,
              `记忆搜索：${query}\n${formatSearch(result)}`,
            );
          }

          const view = await memory.view({
            personaId: active.persona.id,
            scope: chatKey,
            actorQq: command.message.userId,
            allActors: canViewAllActors(command),
          });
          const hasMemory =
            view.user.exists || view.scene?.exists === true || view.allUsers.length > 0;
          if (!hasMemory && view.rawCount === 0) {
            return deliverMemory(
              command,
              active.persona.id,
              "还没有记忆。使用 !remember 或继续聊天后会自动整理。",
            );
          }
          return deliverMemory(
            command,
            active.persona.id,
            formatMemoryView(active.persona.name, view),
          );
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "remember",
        description: "手动记住一条关于你的信息",
        usage: "remember 内容",
        chats: ["private", "group"],
        allowGroupShared: true,
        async handler(command) {
          const chatKey = command.message.chat.chatKey;
          const active = await boundPersona(chatKey);
          if (active === null) return "还没有绑定角色。发送 !persona use 角色ID。";
          const content = command.rawArgs.trim();
          if (content.length === 0) return "用法：!remember 内容";
          if (content.length > MAX_REMEMBER_CHARS) {
            return `最多记 ${MAX_REMEMBER_CHARS} 字，请缩短一点。`;
          }
          await memory.remember({
            personaId: active.persona.id,
            scope: chatKey,
            actorQq: command.message.userId,
            content,
          });
          return "已写入手动记忆。";
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "forget",
        description: "删除当前角色在当前会话中的记忆",
        usage: "forget section 名称 | forget confirm",
        chats: ["private", "group"],
        allowGroupShared: true,
        async handler(command) {
          const chatKey = command.message.chat.chatKey;
          const active = await boundPersona(chatKey);
          if (active === null) return "还没有绑定角色。";
          const sub = command.args[0]?.toLowerCase();
          if (sub === undefined) {
            return "用法：!forget section 名称 | !forget confirm（全部，需要确认）";
          }

          if (!canManageGroup(command)) {
            return "shared 群中只有 owner/admin 可以删除记忆。";
          }

          if (sub === "confirm") {
            const deleted = await memory.forgetAll({
              personaId: active.persona.id,
              scope: chatKey,
              actorQq: command.message.userId,
            });
            return `已删除记忆（原文 ${deleted.messages} 条、变更事件 ${deleted.events} 条）。`;
          }

          if (sub === "section") {
            const section = command.args.slice(1).join(" ").trim();
            if (section.length === 0) return "用法：!forget section 名称";
            const removed = await memory.forgetSection({
              personaId: active.persona.id,
              scope: chatKey,
              actorQq: command.message.userId,
              section,
            });
            return removed ? `已删除 section：${section}` : `没有找到 section：${section}`;
          }

          return "用法：!forget section 名称 | !forget confirm（全部，需要确认）";
        },
      }),
    );

    context.hooks.register({
      async resolveConversationProfile(profile) {
        if (profile.projectId !== options.projectId) return undefined;
        const active = await activePersona(profile.message.chat.chatKey);
        if (active === null) return undefined;
        return {
          directory: active.persona.dir,
          agent: options.agent,
          ...(options.model !== null ? { model: options.model } : {}),
          workspace: "none" as const,
        };
      },

      async beforePrompt(prompt) {
        if (prompt.projectId !== options.projectId) return undefined;
        const chatKey = prompt.message.chat.chatKey;
        const scope = chatKey;
        const active = await activePersona(chatKey);
        if (active === null) return undefined;
        const recent = transcript.recent(
          chatKey,
          Math.max(options.worldbookScanDepth, options.memoryExcludeRecent),
          active.persona.id,
        );
        const worldbook = await worldbookFor(active.persona);
        const selected = selectWorldbook(
          worldbook,
          {
            currentText: prompt.message.text,
            recentTexts: recent.map((row) => row.text),
          },
          {
            scanDepth: options.worldbookScanDepth,
            maxEntries: options.worldbookMaxEntries,
            maxChars: options.worldbookMaxChars,
            recursionSteps: options.worldbookRecursionSteps,
            matchWholeWords: options.worldbookMatchWholeWords,
          },
        );
        const excludeCount = Math.max(0, options.memoryExcludeRecent);
        const excluded =
          excludeCount === 0
            ? []
            : recent.slice(-excludeCount).map((row) => row.id);
        const memoryDocs = await memory.loadForPrompt({
          personaId: active.persona.id,
          scope,
          actorQq: prompt.message.userId,
        });
        const emotions = options.stickerEnabled
          ? listEmotions(await stickerCatalogFor(active.persona))
          : [];
        const memories = transcript.search({
          namespace: active.persona.id,
          scope,
          query: prompt.message.text,
          limit: options.memoryRawTopK,
          excludeIds: excluded,
        });
        const hasUser = recent.some((row) => row.role === "user");
        const scene =
          prompt.message.chat.type === "group"
            ? `群聊 ${prompt.message.chat.groupId ?? ""}`.trim()
            : undefined;
        const block = buildContextBlock({
          personaName: active.persona.name,
          userName: prompt.message.senderName,
          now: Date.now(),
          turnCount: transcript.count(scope, active.persona.id, "user") + 1,
          ...(scene !== undefined ? { scene } : {}),
          ...(emotions.length > 0 ? { emotions } : {}),
          worldbook: selected,
          memories,
          userDoc: memoryDocs.userDoc,
          sceneDoc: memoryDocs.sceneDoc,
          ...(!hasUser && active.persona.firstMes.length > 0
            ? { firstMes: active.persona.firstMes }
            : {}),
          maxChars: Math.max(400, options.memoryMaxChars + options.worldbookMaxChars + 400),
          sectionMaxChars: {
            user: options.memoryUserMaxChars,
            scene: options.memorySceneMaxChars,
            raw: options.memoryRawMaxChars,
          },
        });
        return { prepend: block };
      },

      async formatReply(reply) {
        if (reply.projectId !== options.projectId) return undefined;
        const active = await activePersona(reply.message.chat.chatKey);
        if (active === null) return undefined;
        const tag = extractEmotionTag(reply.text);
        let sticker: { path: string; delayMs: number } | null = null;
        const stickerKey = `${reply.message.chat.chatKey}:${active.persona.id}`;
        const now = Date.now();
        const cooldownActive =
          options.stickerCooldownMs > 0 &&
          now - (lastStickerAt.get(stickerKey) ?? 0) < options.stickerCooldownMs;
        if (options.stickerEnabled && options.stickerJudge !== "off" && !cooldownActive) {
          try {
            const catalog = await stickerCatalogFor(active.persona);
            const emotions = listEmotions(catalog);
            if (emotions.length > 0) {
              const tagEmotion =
                tag.emotion !== null && emotions.includes(tag.emotion) ? tag.emotion : null;
              let emotion: string | null =
                options.stickerJudge === "tag" || options.stickerJudge === "hybrid"
                  ? tagEmotion
                  : null;
              if (
                emotion === null &&
                jev !== null &&
                (options.stickerJudge === "jev" || options.stickerJudge === "hybrid")
              ) {
                const decision = await jev.judge({
                  userText: reply.message.text,
                  replyText: tag.text,
                  emotions,
                });
                context.logger.debug(
                  {
                    personaId: active.persona.id,
                    choice: decision.emotion,
                    confidence: decision.confidence,
                    stickerOk: decision.stickerOk,
                    probabilities: decision.probabilities,
                    costUsd: decision.usage?.cost ?? null,
                  },
                  "Jev sticker decision",
                );
                if (
                  decision.emotion !== null &&
                  decision.confidence >= options.jevMinConfidence &&
                  decision.stickerOk >= options.jevMinStickerOk
                ) {
                  emotion = decision.emotion;
                }
              }
              if (emotion === null && options.stickerJudge === "jev" && jev === null) {
                emotion = tagEmotion;
              }
              if (emotion !== null) {
                const path = chooseSticker(catalog, emotion, stickerKey, lastStickers);
                if (path !== null) {
                  sticker = { path, delayMs: options.stickerDelayMs };
                  lastStickerAt.set(stickerKey, now);
                }
              }
            }
          } catch (error) {
            context.logger.warn(
              { err: error, personaId: active.persona.id, chatKey: reply.message.chat.chatKey },
              "Sticker judgement failed; sending text only",
            );
          }
        }
        const segments = planReplyWithSticker(tag.text, deliveryOptions(options), sticker);
        const replyText = tag.text.length > 0 ? tag.text : null;
        return segments.length > 0
          ? { segments, replyText }
          : { segments: [], suppress: true, replyText };
      },

      async afterRun(run: PluginRunContext) {
        if (run.projectId !== options.projectId) return;
        const active = await activePersona(run.chat.chatKey);
        if (active === null) return;
        memory.recordRun({
          personaId: active.persona.id,
          personaName: active.persona.name,
          chatKey: run.chat.chatKey,
          scope: run.chat.chatKey,
          actorQq: run.userId,
          senderName: run.senderName,
          userText: run.userText,
          replyText: run.replyText,
          sessionId: run.sessionId,
        });
      },
    });

    registerRoleplayAdmin(context.admin, {
      options,
      personasDir,
      stickerRoot,
      memoryRoot: join(context.dataDir, "memory"),
      databasePath: join(context.dataDir, "roleplay.db"),
      agentConfigDir: roleplayConfigDir(options.opencodeConfigDir),
      memory,
      documents,
      transcript,
      bindings,
      messages: context.messages,
      logger: context.logger,
      worldbookCache,
      stickerCache,
      jev,
    });

    mkdirSync(personasDir, { recursive: true, mode: 0o700 });
    mkdirSync(stickerRoot, { recursive: true, mode: 0o700 });
    mkdirSync(join(context.dataDir, "memory"), { recursive: true, mode: 0o700 });

    return async () => {
      if (disposed) return;
      disposed = true;
      await memory.dispose();
      transcript.close();
      bindings.close();
    };
  },

  async start(context: PluginContext<RoleplayOptions>) {
    if (!context.config.installAgent) return;
    const configDir = roleplayConfigDir(context.config.opencodeConfigDir);
    const engine = context.config.agent;
    if (!/^[a-z][a-z0-9-]*$/.test(engine)) {
      context.logger.warn(
        { agent: engine },
        "Roleplay agent id is not a safe filename; skip agent installation",
      );
    } else {
      try {
        const result = await installQqRpAgent({
          configDir,
          agentId: engine,
          version: context.manifest.version || VERSION,
        });
        context.logger.info(
          { path: result.path, action: result.action, agent: engine },
          result.action === "kept"
            ? "Roleplay engine agent already present"
            : "Roleplay engine agent installed; restart or reload OpenCode before using it",
        );
      } catch (error) {
        context.logger.warn({ err: error }, "Failed to install the qq-rp agent");
      }
    }

    const utility = context.config.memoryUtilityAgent;
    if (!/^[a-z][a-z0-9-]*$/.test(utility)) {
      context.logger.warn(
        { agent: utility },
        "Roleplay utility agent id is not a safe filename; skip utility agent installation",
      );
      return;
    }
    try {
      const result = await installQqRpUtilityAgent({
        configDir,
        agentId: utility,
        version: context.manifest.version || VERSION,
      });
      context.logger.info(
        { path: result.path, action: result.action, agent: utility },
        result.action === "kept"
          ? "Roleplay utility agent already present"
          : "Roleplay utility agent installed; restart or reload OpenCode before using it",
      );
    } catch (error) {
      context.logger.warn({ err: error }, "Failed to install the qq-rp utility agent");
    }
  },
});
