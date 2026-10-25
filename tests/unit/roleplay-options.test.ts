import { describe, expect, it } from "vitest";
import { parseRoleplayOptions } from "../../packages/roleplay/src/options.js";

describe("roleplay options", () => {
  it("provides private-chat memory defaults", () => {
    expect(parseRoleplayOptions({})).toMatchObject({
      projectId: "roleplay",
      agent: "qq-rp",
      model: null,
      defaultPersona: null,
      fallbackProject: null,
      maxSegments: 4,
      maxCharsPerSegment: 180,
      memoryEnabled: true,
      memoryUtilityAgent: "qq-rp-utility",
      memoryConsolidateEveryTurns: 8,
      memoryIdleDebounceMs: 120_000,
      memoryUserMaxChars: 1200,
      memorySceneMaxChars: 800,
      memoryRawTopK: 6,
      memoryRawMaxChars: 600,
      memoryMaxChars: 2400,
      memoryHistoryLimit: 20,
      installAgent: true,
    });
  });

  it("accepts overrides and clamps unsafe values", () => {
    const options = parseRoleplayOptions({
      project_id: "rp",
      agent: "custom-rp",
      model: "deepseek/deepseek-v4-flash",
      fallback_project: "demo",
      max_segments: 99,
      max_chars_per_segment: 10,
      delay_per_char_ms: -5,
      memory_raw_top_k: 0,
      memory_idle_debounce_ms: 99_999_999,
      memory_user_max_chars: 10,
      memory_enabled: false,
      install_agent: false,
      opencode_config_dir: "/tmp/opencode",
    });
    expect(options).toMatchObject({
      projectId: "rp",
      agent: "custom-rp",
      model: "deepseek/deepseek-v4-flash",
      fallbackProject: "demo",
      maxSegments: 8,
      maxCharsPerSegment: 40,
      delayPerCharMs: 0,
      memoryRawTopK: 1,
      memoryIdleDebounceMs: 1_800_000,
      memoryUserMaxChars: 200,
      memoryEnabled: false,
      installAgent: false,
      opencodeConfigDir: "/tmp/opencode",
    });
  });

  it("supports the legacy memory_llm switch", () => {
    expect(parseRoleplayOptions({ memory_llm: false }).memoryEnabled).toBe(false);
  });

  it("rejects an empty project id or agent", () => {
    expect(() => parseRoleplayOptions({ project_id: "" })).toThrow();
    expect(() => parseRoleplayOptions({ agent: "" })).toThrow();
  });
});
