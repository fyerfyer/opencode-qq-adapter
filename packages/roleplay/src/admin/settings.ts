import { JevEmotionJudge } from "../jev.js";
import { getPersona } from "../persona.js";
import { listEmotions } from "../stickers.js";
import {
  AdminHttpError,
  type AdminRoute,
  type RoleplayAdminDeps,
  PERSONA_ID,
  diagnostics,
  jevBaseUrlOverride,
  jevTextOverride,
  jevTimeoutOverride,
  readJson,
  summarize,
} from "./shared.js";

export function registerSettingsRoutes(
  route: AdminRoute,
  deps: RoleplayAdminDeps,
): void {
  route("GET", "/summary", async () => summarize(deps));
  route("GET", "/diagnostics", async () => ({ checks: await diagnostics(deps) }));

  route("POST", "/test/jev", async (context) => {
    const body = await readJson(context.request);
    const apiKeyOverride = jevTextOverride(body.apiKey, "API Key", 4096);
    const apiKey =
      apiKeyOverride ?? (process.env[deps.options.jevApiKeyEnv]?.trim() ?? "");
    if (apiKey.length === 0) {
      throw new AdminHttpError(
        503,
        "jev_not_configured",
        `Jev 未配置：请填写当前表单的 API Key，或在环境变量 ${deps.options.jevApiKeyEnv} 中保存密钥。`,
      );
    }
    const baseUrl = jevBaseUrlOverride(
      jevTextOverride(body.baseUrl, "Base URL", 2000) ?? deps.options.jevBaseUrl,
    );
    const endpoint =
      jevTextOverride(body.endpoint, "Endpoint", 200) ?? deps.options.jevEndpoint;
    const model = jevTextOverride(body.model, "Model", 200) ?? deps.options.jevModel;
    const timeoutMs = jevTimeoutOverride(body.timeoutMs, deps.options.jevTimeoutMs);
    const userText = typeof body.userText === "string" ? body.userText : "";
    const replyText = typeof body.replyText === "string" ? body.replyText : "";
    let emotions = Array.isArray(body.emotions)
      ? body.emotions.filter((item): item is string => typeof item === "string")
      : [];
    if (emotions.length === 0) {
      const personaId =
        jevTextOverride(body.persona, "角色 ID", 100) ?? deps.options.defaultPersona;
      if (personaId !== null && PERSONA_ID.test(personaId)) {
        const persona = await getPersona(deps.personasDir, personaId).catch(() => null);
        if (persona !== null) {
          emotions = listEmotions(await deps.stickerCatalogFor(persona.id));
        }
      }
    }
    const judge = new JevEmotionJudge({
      baseUrl,
      endpoint,
      apiKey,
      model,
      timeoutMs,
    });
    const started = Date.now();
    const decision = await judge.judge({ userText, replyText, emotions });
    return {
      ...decision,
      latencyMs: Date.now() - started,
      apiKeyEnv: deps.options.jevApiKeyEnv,
      apiKeySource: apiKeyOverride === null ? "env" : "form",
      baseUrl,
      endpoint,
      model,
      emotionCount: emotions.length,
    };
  });
}
