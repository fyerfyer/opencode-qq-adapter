import { getPersona, type PersonaRecord } from "../persona.js";
import { AdminHttpError } from "./http.js";
import type { RoleplayAdminDeps } from "./types.js";
import { PERSONA_ID } from "./validation.js";

export async function requirePersona(
  deps: RoleplayAdminDeps,
  id: string,
): Promise<PersonaRecord> {
  if (!PERSONA_ID.test(id)) throw new AdminHttpError(400, "invalid_persona", "角色 ID 不合法。");
  const persona = await getPersona(deps.personasDir, id);
  if (persona === null) throw new AdminHttpError(404, "persona_not_found", "角色不存在。");
  return persona;
}

export async function stickerOwner(
  deps: RoleplayAdminDeps,
  id: string,
): Promise<{ id: string }> {
  if (id === "_global") return { id };
  const persona = await requirePersona(deps, id);
  return { id: persona.id };
}
