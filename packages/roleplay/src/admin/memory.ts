import { randomUUID } from "node:crypto";
import { safeMemorySegment } from "@opencode-qq/memory";
import {
  AdminHttpError,
  type AdminRoute,
  type MemoryJob,
  type RoleplayAdminDeps,
  listMemoryScopes,
  memoryHistory,
  memoryTarget,
  param,
  parseActorFromScope,
  readJson,
  readMemoryDoc,
  readMemoryHistory,
  requirePersona,
  writeMemoryDoc,
} from "./shared.js";

export function registerMemoryRoutes(route: AdminRoute, deps: RoleplayAdminDeps): void {
  const jobs = new Map<string, MemoryJob>();

  route("GET", "/memory/scopes", async (context) => {
    const persona = await requirePersona(deps, context.query.get("persona") ?? "");
    return { scopes: await listMemoryScopes(deps, persona.id) };
  });
  route("GET", "/memory/document", async (context) => {
    const { persona, ref, kind, actorQq } = await memoryTarget(deps, context);
    const doc = await readMemoryDoc(deps, persona.id, ref.scope, kind, actorQq);
    return {
      document: doc,
      history: await memoryHistory(deps, persona.id, ref.scope, kind, actorQq),
    };
  });
  route("PUT", "/memory/document", async (context) => {
    const body = await readJson(context.request);
    const persona = await requirePersona(deps, String(body.persona ?? ""));
    const scope = String(body.scope ?? "");
    const kind = body.kind === "scene" ? "scene" : "user";
    const actorQq = Number(body.actorQq ?? 0);
    const content = typeof body.content === "string" ? body.content : null;
    if (content === null) {
      throw new AdminHttpError(400, "invalid_content", "content 必须是字符串。");
    }
    if (!Number.isSafeInteger(actorQq) || actorQq < 0) {
      throw new AdminHttpError(400, "invalid_actor", "actorQq 不合法。");
    }
    const document = await writeMemoryDoc(deps, {
      personaId: persona.id,
      scope,
      actorQq,
      kind,
      content,
      allowManual: body.allowManual === true,
    });
    return {
      document,
      history: await memoryHistory(deps, persona.id, scope, kind, actorQq),
    };
  });
  route("GET", "/memory/history", async (context) => {
    const { persona, ref, kind, actorQq } = await memoryTarget(deps, context);
    return { history: await memoryHistory(deps, persona.id, ref.scope, kind, actorQq) };
  });
  route("GET", "/memory/history/file", async (context) => {
    const path = context.query.get("path") ?? "";
    const content = await readMemoryHistory(deps, path);
    return { content };
  });
  route("POST", "/memory/history/restore", async (context) => {
    const body = await readJson(context.request);
    const path = typeof body.path === "string" ? body.path : "";
    const content = await readMemoryHistory(deps, path);
    const persona = await requirePersona(deps, String(body.persona ?? ""));
    const scope = String(body.scope ?? "");
    const kind = body.kind === "scene" ? "scene" : "user";
    const actorQq = Number(body.actorQq ?? 0);
    const document = await writeMemoryDoc(deps, {
      personaId: persona.id,
      scope,
      actorQq,
      kind,
      content,
      allowManual: true,
    });
    return { document };
  });
  route("GET", "/memory/search", async (context) => {
    const { persona, ref, actorQq } = await memoryTarget(deps, context);
    const query = context.query.get("q")?.trim() ?? "";
    if (query.length === 0) return { docs: [], messages: [] };
    return deps.memory.search({
      personaId: persona.id,
      scope: ref.scope,
      actorQq,
      query,
      allActors: true,
      limit: 10,
    });
  });
  route("POST", "/memory/refresh", async (context) => {
    const body = await readJson(context.request);
    const persona = await requirePersona(deps, String(body.persona ?? ""));
    const scope = String(body.scope ?? "");
    const actorQq = Number(body.actorQq ?? parseActorFromScope(scope) ?? 0);
    const chatKey = deps.bindings
      .list()
      .find((binding) => safeMemorySegment(binding.chatKey) === scope)?.chatKey;
    if (chatKey === undefined) {
      throw new AdminHttpError(409, "no_binding", "该 scope 还没有对应的 QQ 会话绑定。");
    }
    const job: MemoryJob = {
      id: randomUUID(),
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
      error: null,
    };
    jobs.set(job.id, job);
    void deps.memory
      .refresh({
        personaId: persona.id,
        personaName: persona.name,
        chatKey,
        scope,
        actorQq,
        senderName: "管理员",
      })
      .then((result) => {
        job.status = result.failed ? "failed" : "completed";
        job.result = result;
        job.finishedAt = Date.now();
      })
      .catch((error) => {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.finishedAt = Date.now();
      });
    return { job };
  });
  route("GET", "/memory/jobs/:id", async (context) => {
    const job = jobs.get(param(context, "id"));
    if (job === undefined) {
      throw new AdminHttpError(404, "job_not_found", "任务不存在。");
    }
    return { job };
  });
  route("DELETE", "/memory/scope", async (context) => {
    const { persona, ref, actorQq } = await memoryTarget(deps, context);
    const deleted = await deps.memory.forgetAll({
      personaId: persona.id,
      scope: ref.scope,
      actorQq,
    });
    return { deleted: true, ...deleted };
  });
}
