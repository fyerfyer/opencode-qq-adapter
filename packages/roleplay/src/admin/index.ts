import type { PluginAdmin } from "@opencode-qq/plugin-sdk";
import { registerBindingRoutes } from "./bindings.js";
import { registerMemoryRoutes } from "./memory.js";
import { registerPersonaRoutes } from "./personas.js";
import { registerSettingsRoutes } from "./settings.js";
import {
  type AdminHandler,
  type AdminRoute,
  type RoleplayAdminDeps,
  withAdminErrors,
} from "./shared.js";
import { registerStickerRoutes } from "./stickers.js";

export type { RoleplayAdminDeps } from "./shared.js";

export function registerRoleplayAdmin(admin: PluginAdmin, deps: RoleplayAdminDeps): void {
  const route: AdminRoute = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    handler: AdminHandler,
  ) => {
    admin.route(method, path, (context) => withAdminErrors(() => handler(context)));
  };

  admin.page({
    id: "roleplay",
    title: "Roleplay",
    kind: "iframe",
    description: "角色卡、世界书、表情包、记忆和聊天绑定",
  });

  registerSettingsRoutes(route, deps);
  registerPersonaRoutes(route, deps);
  registerStickerRoutes(route, deps);
  registerMemoryRoutes(route, deps);
  registerBindingRoutes(route, deps);
}
