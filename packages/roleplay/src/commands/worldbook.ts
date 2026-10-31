import { defineCommand, type PluginCommands } from "@opencode-qq/plugin-sdk";
import { capText } from "../format.js";
import type { RoleplayRuntime } from "../runtime.js";
import {
  formatWorldbookTrace,
  selectWorldbookDetailed,
} from "../worldbook.js";

export function registerWorldbookCommand(
  commands: PluginCommands,
  runtime: RoleplayRuntime,
): void {
  commands.register(
    defineCommand({
      name: "worldbook",
      description: "调试世界书关键词、递归和预算",
      usage: "worldbook check 文本",
      chats: ["private", "group"],
      async handler(command) {
        const sub = command.args[0]?.toLowerCase();
        const text = command.args.slice(1).join(" ").trim();
        if (sub !== "check" || text.length === 0) {
          return "用法：!worldbook check 文本";
        }
        const chatKey = command.message.chat.chatKey;
        const active = await runtime.boundPersona(chatKey);
        if (active === null) return "还没有绑定角色。发送 !persona use 角色ID。";
        const recent = runtime.transcript.recent(
          chatKey,
          runtime.options.worldbookScanDepth,
          active.persona.id,
        );
        const trace = selectWorldbookDetailed(
          await runtime.worldbookFor(active.persona),
          {
            currentText: text,
            recentTexts: recent.map((row) => row.text),
          },
          {
            scanDepth: runtime.options.worldbookScanDepth,
            maxEntries: runtime.options.worldbookMaxEntries,
            maxChars: runtime.options.worldbookMaxChars,
            recursionSteps: runtime.options.worldbookRecursionSteps,
            matchWholeWords: runtime.options.worldbookMatchWholeWords,
          },
        );
        const output = capText(formatWorldbookTrace(active.persona.name, text, trace));
        return runtime.deliverMemory(command, active.persona.id, output);
      },
    }),
  );
}
