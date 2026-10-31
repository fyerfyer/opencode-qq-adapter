import { defineCommand, type PluginCommands } from "@opencode-qq/plugin-sdk";
import {
  formatDiff,
  formatHistory,
  formatMemoryView,
  formatSearch,
} from "../format.js";
import type { RoleplayRuntime } from "../runtime.js";

const MAX_REMEMBER_CHARS = 200;

export function registerMemoryCommands(
  commands: PluginCommands,
  runtime: RoleplayRuntime,
): void {
  commands.register(
    defineCommand({
      name: "memory",
      description: "查看、搜索或整理当前角色的记忆",
      usage: "memory [search 关键词|refresh|history|diff]",
      chats: ["private", "group"],
      async handler(command) {
        const chatKey = command.message.chat.chatKey;
        const active = await runtime.boundPersona(chatKey);
        if (active === null) return "还没有绑定角色。发送 !persona use 角色ID。";
        const sub = command.args[0]?.toLowerCase();

        if (sub === "refresh") {
          if (command.message.chat.type === "group") {
            return "请在私聊中使用 !memory refresh。";
          }
          await command.reply("正在整理记忆…");
          const result = await runtime.memory.refresh({
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

        if (sub === "history") {
          const events = runtime.memory.history({
            personaId: active.persona.id,
            scope: chatKey,
            limit: 10,
          });
          return runtime.deliverMemory(command, active.persona.id, formatHistory(events));
        }

        if (sub === "diff") {
          const event = runtime.memory.lastEvent({
            personaId: active.persona.id,
            scope: chatKey,
          });
          return runtime.deliverMemory(command, active.persona.id, formatDiff(event));
        }

        if (sub === "search") {
          const query = command.args.slice(1).join(" ").trim();
          if (query.length === 0) return "用法：!memory search 关键词";
          const result = await runtime.memory.search({
            personaId: active.persona.id,
            scope: chatKey,
            actorQq: command.message.userId,
            query,
            allActors: false,
            limit: 5,
          });
          return runtime.deliverMemory(
            command,
            active.persona.id,
            `记忆搜索：${query}\n${formatSearch(result)}`,
          );
        }

        const view = await runtime.memory.view({
          personaId: active.persona.id,
          scope: chatKey,
          actorQq: command.message.userId,
          allActors: false,
        });
        const hasMemory =
          view.user.exists || view.scene?.exists === true || view.allUsers.length > 0;
        if (!hasMemory && view.rawCount === 0) {
          return runtime.deliverMemory(
            command,
            active.persona.id,
            "还没有记忆。使用 !remember 或继续聊天后会自动整理。",
          );
        }
        return runtime.deliverMemory(
          command,
          active.persona.id,
          formatMemoryView(active.persona.name, view),
        );
      },
    }),
  );

  commands.register(
    defineCommand({
      name: "remember",
      description: "手动记住一条关于你的信息",
      usage: "remember 内容",
      chats: ["private", "group"],
      async handler(command) {
        const chatKey = command.message.chat.chatKey;
        const active = await runtime.boundPersona(chatKey);
        if (active === null) return "还没有绑定角色。发送 !persona use 角色ID。";
        const content = command.rawArgs.trim();
        if (content.length === 0) return "用法：!remember 内容";
        if (content.length > MAX_REMEMBER_CHARS) {
          return `最多记 ${MAX_REMEMBER_CHARS} 字，请缩短一点。`;
        }
        await runtime.memory.remember({
          personaId: active.persona.id,
          scope: chatKey,
          actorQq: command.message.userId,
          content,
        });
        return "已写入手动记忆。";
      },
    }),
  );

  commands.register(
    defineCommand({
      name: "forget",
      description: "删除当前角色在当前会话中的记忆",
      usage: "forget section 名称 | forget confirm",
      chats: ["private", "group"],
      async handler(command) {
        const chatKey = command.message.chat.chatKey;
        const active = await runtime.boundPersona(chatKey);
        if (active === null) return "还没有绑定角色。";
        const sub = command.args[0]?.toLowerCase();
        if (sub === undefined) {
          return "用法：!forget section 名称 | !forget confirm（全部，需要确认）";
        }

        if (sub === "confirm") {
          const deleted = await runtime.memory.forgetAll({
            personaId: active.persona.id,
            scope: chatKey,
            actorQq: command.message.userId,
          });
          return `已删除记忆（原文 ${deleted.messages} 条、变更事件 ${deleted.events} 条）。`;
        }

        if (sub === "section") {
          const section = command.args.slice(1).join(" ").trim();
          if (section.length === 0) return "用法：!forget section 名称";
          const removed = await runtime.memory.forgetSection({
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
}
