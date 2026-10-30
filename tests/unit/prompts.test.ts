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

  it("sets and clears an agent model while preserving frontmatter comments", async () => {
    const { root, store } = await setup();
    await writeFile(
      join(root, "my-agent.md"),
      "---\n# keep this comment\ndescription: Mine\nmode: primary\n---\n\nBody\n",
      "utf8",
    );

    const withModel = await store.setModel("my-agent.md", "fake/model-b");
    expect(withModel.model).toBe("fake/model-b");
    expect(withModel.content).toContain("# keep this comment");
    expect(withModel.content).toContain("model: fake/model-b");
    expect(withModel.content).toContain("Body");

    const replaced = await store.setModel("my-agent.md", "fake/model-a");
    expect(replaced.content.match(/^model:/gm)).toHaveLength(1);
    expect(replaced.content).toContain("model: fake/model-a");

    const inherited = await store.setModel("my-agent.md", null);
    expect(inherited.model).toBeNull();
    expect(inherited.content).not.toContain("model:");
    expect(inherited.content).toContain("# keep this comment");
  });

  it("adds frontmatter when an agent has no model block", async () => {
    const { root, store } = await setup();
    await writeFile(join(root, "plain.md"), "Plain body\n", "utf8");
    const saved = await store.setModel("plain.md", "fake/model-b");
    expect(saved.content.startsWith("---\nmodel: fake/model-b\n---\n\n")).toBe(true);
    expect(saved.content).toContain("Plain body");
  });

  it("requires override to change the model of a plugin-managed agent", async () => {
    const { root, store } = await setup();
    await writeFile(
      join(root, "qq-rp.md"),
      "---\n# managed by @opencode-qq/roleplay; version: 0.5.0\n---\n\nRP\n",
      "utf8",
    );
    await expect(store.setModel("qq-rp.md", "fake/model-a")).rejects.toMatchObject({
      status: 409,
      code: "prompt_managed",
    });
    const saved = await store.setModel("qq-rp.md", "fake/model-a", { override: true });
    expect(saved.model).toBe("fake/model-a");
  });
});
