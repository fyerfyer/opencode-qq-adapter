import { defineCommand, type PluginCommands } from "@opencode-qq/plugin-sdk";
import { getPersona, listPersonas } from "../persona.js";
import type { RoleplayRuntime } from "../runtime.js";
import { listEmotions, stickerCount } from "../stickers.js";

export function registerPersonaCommand(
  commands: PluginCommands,
  runtime: RoleplayRuntime,
): void {
  commands.register(
    defineCommand({
      name: "persona",
      description: "列出、查看或使用角色卡",
      usage: "persona [list|info|use] [id]",
      chats: ["private", "group"],
      async handler(command) {
        const sub = command.args[0]?.toLowerCase() ?? "list";
        const chatKey = command.message.chat.chatKey;
        const binding = runtime.bindings.get(chatKey);

        if (sub === "list") {
          const personas = await listPersonas(runtime.personasDir);
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
        const persona = await getPersona(runtime.personasDir, id);
        if (persona === null) return `找不到角色：${id}`;

        if (sub === "info") {
          const worldbook = await runtime.worldbookFor(persona);
          const stickers = await runtime.stickerCatalogFor(persona);
          const emotions = listEmotions(stickers);
          const view = await runtime.memory.view({
            personaId: persona.id,
            scope: chatKey,
            actorQq: command.message.userId,
            allActors: false,
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
          return await runtime.activate(command, persona, true);
        }
        return "用法：!persona list | !persona info [id] | !persona use 角色ID";
      },
    }),
  );
}
