import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PromptStore } from "../../src/admin/prompts.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "qq-prompts-"));
  const store = new PromptStore({ root });
  return { root, store };
}

describe("PromptStore ownership", () => {
  it("classifies core, plugin-managed and user prompts", async () => {
    const { root, store } = await setup();
    await writeFile(
      join(root, "qq-rp.md"),
      "---\n# managed by @opencode-qq/roleplay; version: 0.4.0\ndescription: RP\n---\n\nRP prompt\n",
      "utf8",
    );
    await writeFile(
      join(root, "qq-code.md"),
      "---\ndescription: QQ coding\n---\n\nCoding\n",
      "utf8",
    );
    await writeFile(join(root, "my-agent.md"), "---\ndescription: Mine\n---\n\nMine\n", "utf8");

    const list = await store.list();
    expect(list.find((item) => item.name === "qq-rp.md")).toMatchObject({
      owner: "plugin",
      managedBy: "@opencode-qq/roleplay",
      editable: false,
    });
    expect(list.find((item) => item.name === "qq-code.md")).toMatchObject({
      owner: "core",
      managedBy: "opencode-qq-adapter",
      editable: true,
    });
    expect(list.find((item) => item.name === "my-agent.md")).toMatchObject({
      owner: "user",
      editable: true,
    });
  });

  it("requires an explicit override for plugin-managed prompts", async () => {
    const { root, store } = await setup();
    await writeFile(
      join(root, "qq-rp.md"),
      "---\n# managed by @opencode-qq/roleplay; version: 0.4.0\ndescription: RP\n---\n\nRP prompt\n",
      "utf8",
    );

    await expect(store.write("qq-rp.md", "changed")).rejects.toMatchObject({
      status: 409,
      code: "prompt_managed",
    });
    const saved = await store.write("qq-rp.md", "changed", { override: true });
    expect(saved.content).toBe("changed");
  });

  it("allows normal writes and restores for user prompts", async () => {
    const { root, store } = await setup();
    await writeFile(join(root, "my-agent.md"), "v1\n", "utf8");
    await store.write("my-agent.md", "v2\n");
    expect((await store.read("my-agent.md")).content).toBe("v2\n");
  });
});
