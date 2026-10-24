import { describe, expect, it } from "vitest";
import { parseRoleplayOptions } from "../../packages/roleplay/src/options.js";

describe("roleplay options", () => {
  it("provides private-chat defaults", () => {
    expect(parseRoleplayOptions({})).toMatchObject({
      projectId: "roleplay",
      agent: "qq-rp",
      model: null,
      defaultPersona: null,
      fallbackProject: null,
      maxSegments: 4,
      maxCharsPerSegment: 180,
      memoryTopK: 6,
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
      memory_top_k: 0,
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
      memoryTopK: 1,
      installAgent: false,
      opencodeConfigDir: "/tmp/opencode",
    });
  });

  it("rejects an empty project id or agent", () => {
    expect(() => parseRoleplayOptions({ project_id: "" })).toThrow();
    expect(() => parseRoleplayOptions({ agent: "" })).toThrow();
  });
});
