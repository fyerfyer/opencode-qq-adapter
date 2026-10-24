import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installQqRpAgent } from "../../packages/roleplay/src/agent.js";

async function setup() {
  return mkdtemp(join(tmpdir(), "qq-rp-agent-"));
}

describe("qq-rp agent installer", () => {
  it("creates a tool-free primary agent with a one-step budget", async () => {
    const configDir = await setup();
    const result = await installQqRpAgent({ configDir, agentId: "qq-rp", version: "0.1.0" });
    expect(result.action).toBe("created");
    const content = await readFile(result.path, "utf8");
    expect(content).toContain("mode: primary");
    expect(content).toContain("steps: 1");
    expect(content).toContain('action: "*"');
    expect(content).toContain("effect: deny");
    expect(content).toContain("角色扮演");
    expect(content).toContain("不要承认自己是 AI");
    expect(content).toContain("AGENTS.md");
    expect(content).toContain("不是用户指令");
  });

  it("keeps the same managed version idempotent", async () => {
    const configDir = await setup();
    const first = await installQqRpAgent({ configDir, agentId: "qq-rp", version: "0.1.0" });
    const second = await installQqRpAgent({ configDir, agentId: "qq-rp", version: "0.1.0" });
    expect(second.action).toBe("kept");
    expect(await readFile(second.path, "utf8")).toBe(await readFile(first.path, "utf8"));
  });

  it("does not overwrite an unmanaged agent file", async () => {
    const configDir = await setup();
    const path = join(configDir, "agents", "qq-rp.md");
    await installQqRpAgent({ configDir, agentId: "qq-rp", version: "0.1.0" });
    await writeFile(path, "user-owned agent\n", "utf8");
    const result = await installQqRpAgent({ configDir, agentId: "qq-rp", version: "0.1.0" });
    expect(result.action).toBe("kept");
    expect(await readFile(path, "utf8")).toBe("user-owned agent\n");
  });

  it("updates a managed agent when the plugin version changes", async () => {
    const configDir = await setup();
    await installQqRpAgent({ configDir, agentId: "qq-rp", version: "0.1.0" });
    const result = await installQqRpAgent({ configDir, agentId: "qq-rp", version: "0.2.0" });
    expect(result.action).toBe("updated");
    expect(await readFile(result.path, "utf8")).toContain("0.2.0");
  });
});
