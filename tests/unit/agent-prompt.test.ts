import { describe, expect, it } from "vitest";
import { renderQqCodeAgent } from "../../src/setup/agent.js";

describe("QQ code agent prompt", () => {
  it("tells the model not to call the interactive question tool", () => {
    const prompt = renderQqCodeAgent();
    expect(prompt).toContain("Do not call the `question` tool");
    expect(prompt).toContain("plain text");
  });
});
