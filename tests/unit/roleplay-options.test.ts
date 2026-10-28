import { describe, expect, it } from "vitest";
import { parseRoleplayOptions } from "../../packages/roleplay/src/options.js";

describe("roleplay options", () => {
  it("provides private-chat memory defaults without Agent ownership", () => {
    const options = parseRoleplayOptions({});
    expect(options).toMatchObject({
      projectId: "roleplay",
      defaultPersona: null,
      fallbackProject: null,
      maxSegments: 4,
      maxCharsPerSegment: 180,
      worldbookRecursionSteps: 1,
      worldbookMatchWholeWords: false,
      stickerEnabled: true,
      stickerDelayMs: 600,
      stickerCooldownMs: 30_000,
      stickerJudge: "jev",
      jevBaseUrl: "https://api.typesafe.ai/v1",
      jevEndpoint: "decisions",
      jevModel: "jev-latest",
      jevApiKeyEnv: "TYPESAFE_API_KEY",
      jevMinConfidence: 0.45,
      jevMinStickerOk: 0.8,
      jevTimeoutMs: 2500,
      memoryEnabled: true,
      memoryConsolidateEveryTurns: 8,
      memoryIdleDebounceMs: 120_000,
      memoryUserMaxChars: 1200,
      memorySceneMaxChars: 800,
      memoryRawTopK: 6,
      memoryRawMaxChars: 600,
      memoryMaxChars: 2400,
      memoryHistoryLimit: 20,
    });
    expect(options).not.toHaveProperty("agent");
    expect(options).not.toHaveProperty("memoryUtilityAgent");
    expect(options).not.toHaveProperty("installAgent");
    expect(options).not.toHaveProperty("opencodeConfigDir");
  });

  it("accepts overrides and clamps unsafe values", () => {
    const options = parseRoleplayOptions({
      project_id: "rp",
      fallback_project: "demo",
      max_segments: 99,
      max_chars_per_segment: 10,
      delay_per_char_ms: -5,
      worldbook_recursion_steps: 99,
      worldbook_match_whole_words: true,
      sticker_judge: "hybrid",
      jev_base_url: "https://relay.test/v1",
      jev_endpoint: "decisions",
      jev_model: "jev-1.13",
      jev_api_key_env: "JEV_TEST_KEY",
      jev_min_confidence: 0.9,
      jev_min_sticker_ok: 0.8,
      jev_timeout_ms: 800,
      memory_raw_top_k: 0,
      memory_idle_debounce_ms: 99_999_999,
      memory_user_max_chars: 10,
      memory_enabled: false,
    });
    expect(options).toMatchObject({
      projectId: "rp",
      fallbackProject: "demo",
      maxSegments: 8,
      maxCharsPerSegment: 40,
      delayPerCharMs: 0,
      worldbookRecursionSteps: 3,
      worldbookMatchWholeWords: true,
      stickerJudge: "hybrid",
      jevBaseUrl: "https://relay.test/v1",
      jevModel: "jev-1.13",
      jevApiKeyEnv: "JEV_TEST_KEY",
      jevMinConfidence: 0.9,
      jevMinStickerOk: 0.8,
      jevTimeoutMs: 800,
      memoryRawTopK: 1,
      memoryIdleDebounceMs: 1_800_000,
      memoryUserMaxChars: 200,
      memoryEnabled: false,
    });
  });

  it("supports the legacy memory_llm switch", () => {
    expect(parseRoleplayOptions({ memory_llm: false }).memoryEnabled).toBe(false);
  });

  it("ignores removed Agent, model and installer keys", () => {
    const options = parseRoleplayOptions({
      agent: "",
      model: "legacy/engine-model",
      memory_utility_agent: "legacy-utility",
      memory_utility_model: "legacy/utility-model",
      install_agent: false,
      opencode_config_dir: "/tmp/opencode",
    });
    expect(options).not.toHaveProperty("agent");
    expect(options).not.toHaveProperty("model");
    expect(options).not.toHaveProperty("memoryUtilityAgent");
    expect(options).not.toHaveProperty("memoryUtilityModel");
    expect(options).not.toHaveProperty("installAgent");
    expect(options).not.toHaveProperty("opencodeConfigDir");
  });

  it("rejects an invalid sticker judge", () => {
    expect(() => parseRoleplayOptions({ sticker_judge: "magic" })).toThrow();
  });

  it("rejects an empty project id", () => {
    expect(() => parseRoleplayOptions({ project_id: "" })).toThrow();
  });
});
