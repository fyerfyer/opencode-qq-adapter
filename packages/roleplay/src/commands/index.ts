import type { PluginCommands } from "@opencode-qq/plugin-sdk";
import type { RoleplayRuntime } from "../runtime.js";
import { registerCardCommand } from "./card.js";
import { registerMemoryCommands } from "./memory.js";
import { registerPersonaCommand } from "./persona.js";
import { registerRpCommand } from "./rp.js";
import { registerStickerCommand } from "./sticker.js";
import { registerWorldbookCommand } from "./worldbook.js";

export function registerRoleplayCommands(
  commands: PluginCommands,
  runtime: RoleplayRuntime,
): void {
  registerCardCommand(commands, runtime);
  registerPersonaCommand(commands, runtime);
  registerStickerCommand(commands, runtime);
  registerWorldbookCommand(commands, runtime);
  registerRpCommand(commands, runtime);
  registerMemoryCommands(commands, runtime);
}
