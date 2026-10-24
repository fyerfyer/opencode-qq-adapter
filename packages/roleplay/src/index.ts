import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  defineCommand,
  definePlugin,
  type PluginCommandContext,
  type PluginContext,
  type PluginMessage,
  type PluginRunContext,
} from "@opencode-qq/plugin-sdk";
import { installQqRpAgent } from "./agent.js";
import { type DeliveryOptions, planReply } from "./delivery.js";
import { MemoryStore } from "./memory.js";
import { parseRoleplayOptions, type RoleplayOptions } from "./options.js";
import { getPersona, importCard, listPersonas, type PersonaRecord } from "./persona.js";
import { buildContextBlock } from "./prompt.js";
import { formatTimestamp } from "./time.js";
import { isWorldbookEntry, selectWorldbook, type WorldbookEntry } from "./worldbook.js";

const VERSION = "0.1.0";

function scopeFor(message: PluginMessage): string {
  return `private:${message.userId}`;
}

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

export default definePlugin<RoleplayOptions>({
  options: { parse: parseRoleplayOptions },
  setup(context) {
    const options = context.config;
    const personasDir =
      options.personasDir !== null
        ? expandPath(options.personasDir)
        : join(context.dataDir, "personas");
    const store = new MemoryStore(join(context.dataDir, "roleplay.db"));
    const worldbookCache = new Map<string, WorldbookEntry[]>();
    let disposed = false;

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
        const entries = Array.isArray(parsed) ? parsed.filter(isWorldbookEntry) : [];
        worldbookCache.set(persona.id, entries);
        return entries;
      } catch {
        worldbookCache.set(persona.id, []);
        return [];
      }
    };

    const boundPersona = async (chatKey: string) => {
      const binding = store.getBinding(chatKey);
      if (binding === null) return null;
      const persona = await getPersona(personasDir, binding.personaId);
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
      const existing = store.getBinding(chatKey);
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
        existing.personaId !== persona.id ||
        !alreadyOnProject;
      if (needsReset) {
        const reset = context.sessions.reset(chatKey, command.actor);
        if (!reset.ok) return reset.reason ?? "重置会话失败。";
      }

      store.setBinding({
        chatKey,
        personaId: persona.id,
        previousProjectId,
        enabled: true,
        updatedAt: Date.now(),
      });

      if (sendGreeting && needsReset) {
        const greeting = persona.firstMes.trim();
        if (greeting.length > 0) {
          store.addMessage({
            personaId: persona.id,
            chatKey,
            scope: scopeFor(command.message),
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

    context.commands.register(
      defineCommand({
        name: "card",
        description: "导入 Character Card V2/V3",
        usage: "card import <path> [id]",
        chats: ["private"],
        roles: ["owner"],
        async handler(command) {
          const sub = command.args[0]?.toLowerCase();
          const source = command.args[1];
          if (sub !== "import" || source === undefined) {
            return "用法：!card import <path> [id]";
          }
          try {
            const result = await importCard({
              sourcePath: expandPath(source),
              personasDir,
              ...(command.args[2] !== undefined ? { id: command.args[2] } : {}),
            });
            worldbookCache.set(result.persona.id, result.worldbook);
            return [
              `已导入角色：${result.persona.name}（${result.persona.id}）`,
              `世界书：${result.worldbook.length} 条`,
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
        chats: ["private"],
        allowGroupShared: false,
        async handler(command) {
          const sub = command.args[0]?.toLowerCase() ?? "list";
          const chatKey = command.message.chat.chatKey;
          const binding = store.getBinding(chatKey);

          if (sub === "list") {
            const personas = await listPersonas(personasDir);
            if (personas.length === 0) return "还没有角色卡。发送 !card import <path> 导入。";
            return [
              `角色卡（${personas.length}）：`,
              ...personas.map(
                (persona) =>
                  `- ${persona.id} · ${persona.name}${binding?.personaId === persona.id ? "（当前）" : ""}`,
              ),
              "使用 !persona use <id> 切换。",
            ].join("\n");
          }

          const id = command.args[1] ?? binding?.personaId;
          if (id === undefined) return "用法：!persona use <id>";
          const persona = await getPersona(personasDir, id);
          if (persona === null) return `找不到角色：${id}`;

          if (sub === "info") {
            const worldbook = await worldbookFor(persona);
            return [
              `角色：${persona.name}（${persona.id}）`,
              `开场白：${persona.firstMes || "（无）"}`,
              `世界书：${worldbook.length} 条`,
              `记忆：${store.count(scopeFor(command.message), persona.id)} 条`,
              `目录：${persona.dir}`,
            ].join("\n");
          }

          if (sub === "use") {
            return await activate(command, persona, true);
          }
          return "用法：!persona list | !persona info [id] | !persona use <id>";
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "rp",
        description: "查看、开启或关闭角色扮演",
        usage: "rp [on|off|status]",
        chats: ["private"],
        async handler(command) {
          const sub = command.args[0]?.toLowerCase() ?? "status";
          const chatKey = command.message.chat.chatKey;
          const binding = store.getBinding(chatKey);

          if (sub === "status") {
            if (binding === null) return "角色扮演未配置。发送 !persona list 查看角色卡。";
            const persona = await getPersona(personasDir, binding.personaId);
            return [
              `状态：${binding.enabled ? "开启" : "关闭"}`,
              `角色：${persona?.name ?? binding.personaId}`,
              `项目：${options.projectId}`,
              `会话：${(context.sessions.get(chatKey) ?? command.conversation)?.sessionId ?? "尚未创建"}`,
            ].join("\n");
          }

          if (sub === "off") {
            if (binding === null) return "当前没有绑定角色。";
            store.setBinding({ ...binding, enabled: false, updatedAt: Date.now() });
            const restoreTo = binding.previousProjectId ?? options.fallbackProject;
            if (restoreTo === null) {
              context.sessions.reset(chatKey, command.actor);
              return "角色扮演已关闭。当前没有可恢复的项目，请发送 !use <项目> 选择 coding 项目。";
            }
            const restored = context.sessions.setProject(chatKey, restoreTo, command.actor);
            if (!restored.ok) {
              return `已关闭角色扮演，但恢复原项目失败：${restored.reason ?? "未知原因"}`;
            }
            context.sessions.reset(chatKey, command.actor);
            return "角色扮演已关闭。下次发送 !persona use <id> 可以重新开启。";
          }

          if (sub === "on") {
            if (binding === null) {
              if (options.defaultPersona === null) {
                return "请先发送 !persona use <id> 选择角色。";
              }
              const fallback = await getPersona(personasDir, options.defaultPersona);
              if (fallback === null) {
                return `默认角色卡不存在：${options.defaultPersona}`;
              }
              return await activate(command, fallback, true);
            }
            const persona = await getPersona(personasDir, binding.personaId);
            if (persona === null) return `角色卡已丢失：${binding.personaId}`;
            return await activate(command, persona, true);
          }
          return "用法：!rp on | !rp off | !rp status";
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "memory",
        description: "查看当前角色的最近记忆",
        usage: "memory",
        chats: ["private"],
        async handler(command) {
          const chatKey = command.message.chat.chatKey;
          const active = await boundPersona(chatKey);
          if (active === null) return "还没有绑定角色。发送 !persona use <id>。";
          const rows = store.recent(chatKey, 5, active.persona.id);
          if (rows.length === 0) return "还没有记忆。";
          return [
            `最近记忆（${rows.length}）：`,
            ...rows.map((row) => `- [${formatTimestamp(row.ts)}] ${row.speaker}：${row.text}`),
          ].join("\n");
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "forget",
        description: "删除当前角色的私聊记忆",
        usage: "forget confirm",
        chats: ["private"],
        async handler(command) {
          if (command.args[0]?.toLowerCase() !== "confirm") {
            return "这会删除当前角色在本私聊中的全部原文记忆。确认请发送：!forget confirm";
          }
          const chatKey = command.message.chat.chatKey;
          const active = await boundPersona(chatKey);
          if (active === null) return "还没有绑定角色。";
          const deleted = store.forget({
            personaId: active.persona.id,
            scope: scopeFor(command.message),
          });
          return `已删除 ${deleted} 条记忆。`;
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
        const active = await activePersona(chatKey);
        if (active === null) return undefined;
        const scope = scopeFor(prompt.message);
        const recent = store.recent(
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
          },
        );
        const excludeCount = Math.max(0, options.memoryExcludeRecent);
        const excluded =
          excludeCount === 0
            ? []
            : recent.slice(-excludeCount).map((row) => row.id);
        const memories = store.search({
          personaId: active.persona.id,
          scope,
          query: prompt.message.text,
          limit: options.memoryTopK,
          excludeIds: excluded,
        });
        const hasUser = recent.some((row) => row.role === "user");
        const block = buildContextBlock({
          personaName: active.persona.name,
          userName: prompt.message.senderName,
          now: Date.now(),
          turnCount: store.count(scope, active.persona.id, "user") + 1,
          worldbook: selected,
          memories,
          ...(!hasUser && active.persona.firstMes.length > 0
            ? { firstMes: active.persona.firstMes }
            : {}),
          maxChars: Math.max(400, options.memoryMaxChars + options.worldbookMaxChars + 400),
        });
        return { prepend: block };
      },

      async formatReply(reply) {
        if (reply.projectId !== options.projectId) return undefined;
        const active = await activePersona(reply.message.chat.chatKey);
        if (active === null) return undefined;
        const segments = planReply(reply.text, deliveryOptions(options));
        return segments.length > 0 ? { segments } : undefined;
      },

      async afterRun(run: PluginRunContext) {
        if (run.projectId !== options.projectId) return;
        const active = await activePersona(run.chat.chatKey);
        if (active === null) return;
        const scope = `private:${run.userId}`;
        const ts = Date.now();
        if (run.userText.trim().length > 0) {
          store.addMessage({
            personaId: active.persona.id,
            chatKey: run.chat.chatKey,
            scope,
            role: "user",
            speaker: run.senderName,
            text: run.userText,
            ts,
            qqMessageId: undefined,
            sessionId: run.sessionId ?? undefined,
          });
        }
        if (run.replyText !== null && run.replyText.trim().length > 0) {
          store.addMessage({
            personaId: active.persona.id,
            chatKey: run.chat.chatKey,
            scope,
            role: "assistant",
            speaker: active.persona.name,
            text: run.replyText,
            ts: ts + 1,
            sessionId: run.sessionId ?? undefined,
          });
        }
      },
    });

    return async () => {
      if (disposed) return;
      disposed = true;
      store.close();
    };
  },

  async start(context: PluginContext<RoleplayOptions>) {
    if (!context.config.installAgent) return;
    if (!/^[a-z][a-z0-9-]*$/.test(context.config.agent)) {
      context.logger.warn(
        { agent: context.config.agent },
        "Roleplay agent id is not a safe filename; skip agent installation",
      );
      return;
    }
    try {
      const result = await installQqRpAgent({
        configDir: roleplayConfigDir(context.config.opencodeConfigDir),
        agentId: context.config.agent,
        version: context.manifest.version || VERSION,
      });
      context.logger.info(
        { path: result.path, action: result.action, agent: context.config.agent },
        result.action === "kept"
          ? "Roleplay engine agent already present"
          : "Roleplay engine agent installed; restart or reload OpenCode before using it",
      );
    } catch (error) {
      context.logger.warn({ err: error }, "Failed to install the qq-rp agent");
    }
  },
});
