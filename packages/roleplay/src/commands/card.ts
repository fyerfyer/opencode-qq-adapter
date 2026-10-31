import { defineCommand, type PluginCommands } from "@opencode-qq/plugin-sdk";
import { errorMessage } from "../format.js";
import { importCard } from "../persona.js";
import { expandPath, type RoleplayRuntime } from "../runtime.js";

export function registerCardCommand(commands: PluginCommands, runtime: RoleplayRuntime): void {
  commands.register(
    defineCommand({
      name: "card",
      description: "导入 Character Card V2/V3",
      usage: "card import 文件路径 [id]",
      chats: ["private"],
      roles: ["owner", "admin"],
      async handler(command) {
        const sub = command.args[0]?.toLowerCase();
        const source = command.args[1];
        if (sub !== "import" || source === undefined) {
          return "用法：!card import 文件路径 [id]";
        }
        try {
          const result = await importCard({
            sourcePath: expandPath(source),
            personasDir: runtime.personasDir,
            stickerRoot: runtime.stickerRoot,
            ...(command.args[2] !== undefined ? { id: command.args[2] } : {}),
          });
          runtime.worldbookCache.set(result.persona.id, result.worldbook);
          runtime.stickerCache.delete(result.persona.id);
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
}
