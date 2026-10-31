/**
 * Compatibility entry for the split admin routes.
 *
 * Route groups and shared helpers live under `admin/`; keeping this module
 * preserves the original `roleplay/src/admin.js` import path.
 */
export { registerRoleplayAdmin } from "./admin/index.js";
export type { RoleplayAdminDeps } from "./admin/index.js";
