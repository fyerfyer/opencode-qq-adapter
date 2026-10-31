import { defineCommand, type PluginCommands } from "@opencode-qq/plugin-sdk";
import type { RoleplayRuntime } from "../runtime.js";
import { chooseSticker, listEmotions, stickerCount } from "../stickers.js";

export function registerStickerCommand(
  commands: PluginCommands,
  runtime: RoleplayRuntime,
): void {
  commands.register(
    defineCommand({
      name: "sticker",
      description: "查看或测试当前角色的表情素材",
      usage: "sticker [list|reload] | sticker test 情绪",
      chats: ["private"],
      roles: ["owner", "admin"],
      async handler(command) {
        const sub = command.args[0]?.toLowerCase() ?? "list";
        const chatKey = command.message.chat.chatKey;
        const active = await runtime.boundPersona(chatKey);
        if (active === null) return "还没有绑定角色。发送 !persona use 角色ID。";
        if (sub === "reload") {
          runtime.stickerCache.delete(active.persona.id);
          return "表情素材缓存已刷新。";
        }
        const catalog = await runtime.stickerCatalogFor(active.persona);
        const emotions = listEmotions(catalog);
        if (sub === "test") {
          const emotion = command.args[1]?.toLowerCase();
          if (emotion === undefined) return "用法：!sticker test 情绪";
          const path = chooseSticker(
            catalog,
            emotion,
            `sticker-test:${active.persona.id}:${chatKey}`,
            runtime.lastStickers,
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
}
