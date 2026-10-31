import {
  AdminHttpError,
  type AdminRoute,
  type RoleplayAdminDeps,
  readJson,
} from "./shared.js";

export function registerBindingRoutes(
  route: AdminRoute,
  deps: RoleplayAdminDeps,
): void {
  route("GET", "/bindings", async () => {
    return {
      bindings: deps.bindings.list().map((binding) => ({
        ...binding,
        personaId: binding.namespace,
        personaName: binding.namespace,
      })),
    };
  });
  route("PATCH", "/bindings", async (context) => {
    const chatKey = context.query.get("chatKey") ?? "";
    const body = await readJson(context.request);
    if (typeof body.enabled !== "boolean") {
      throw new AdminHttpError(400, "invalid_enabled", "enabled 必须是布尔值。");
    }
    const binding = deps.bindings.setEnabled(chatKey, body.enabled);
    if (binding === null) {
      throw new AdminHttpError(404, "binding_not_found", "绑定不存在。");
    }
    return { binding };
  });
  route("DELETE", "/bindings", async (context) => {
    const chatKey = context.query.get("chatKey") ?? "";
    const deleted = deps.bindings.remove(chatKey);
    return { deleted };
  });
}
