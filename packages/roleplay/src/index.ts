import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "@opencode-qq/plugin-sdk";
import { registerRoleplayAdmin } from "./admin.js";
import { registerRoleplayCommands } from "./commands/index.js";
import { parseRoleplayOptions, type RoleplayOptions } from "./options.js";
import { createRoleplayRuntime } from "./runtime.js";
import { registerRoleplayHooks } from "./runtime/hooks.js";

export default definePlugin<RoleplayOptions>({
  options: { parse: parseRoleplayOptions },
  setup(context) {
    const runtime = createRoleplayRuntime(context);

    registerRoleplayCommands(context.commands, runtime);
    registerRoleplayHooks(context, runtime);
    registerRoleplayAdmin(context.admin, {
      options: runtime.options,
      personasDir: runtime.personasDir,
      stickerRoot: runtime.stickerRoot,
      memoryRoot: runtime.memoryRoot,
      databasePath: runtime.databasePath,
      memory: runtime.memory,
      documents: runtime.documents,
      transcript: runtime.transcript,
      bindings: runtime.bindings,
      messages: context.messages,
      logger: context.logger,
      worldbookCache: runtime.worldbookCache,
      stickerCache: runtime.stickerCache,
      worldbookFor: runtime.worldbookFor,
      stickerCatalogFor: runtime.stickerCatalogFor,
      jev: runtime.jev,
    });

    mkdirSync(runtime.personasDir, { recursive: true, mode: 0o700 });
    mkdirSync(runtime.stickerRoot, { recursive: true, mode: 0o700 });
    mkdirSync(join(context.dataDir, "memory"), { recursive: true, mode: 0o700 });

    return () => runtime.dispose();
  },
});
