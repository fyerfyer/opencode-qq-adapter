import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyOperations,
  docForPrompt,
  MANUAL_SECTION,
  MemoryDocumentStore,
  normalizeDocument,
  parseDocument,
  renderDocument,
} from "../../packages/roleplay/src/memory-document.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "qq-rp-doc-"));
  const store = new MemoryDocumentStore({ root, historyLimit: 3 });
  return { root, store };
}

describe("roleplay memory documents", () => {
  it("renders the default sections and preserves unknown sections", () => {
    const parsed = parseDocument(
      ["# 用户记忆", "", "## 喜好", "- 喜欢吃白米饭", "", "## 自定义", "- 保留我", ""].join("\n"),
      "user",
    );
    const rendered = renderDocument(parsed, "user");
    expect(rendered).toContain("## 基本信息");
    expect(rendered).toContain("## 喜好\n- 喜欢吃白米饭");
    expect(rendered).toContain("## 自定义\n- 保留我");
    expect(rendered).toContain("## 手动记忆");
  });

  it("applies section operations and protects manual memory", () => {
    const base = normalizeDocument("", "user");
    const result = applyOperations(
      base,
      [
        { op: "upsert", section: "基本信息", content: "- 称呼：鱼片" },
        { op: "append", section: "喜好", content: "- 喜欢吃白米饭" },
        { op: "append", section: "喜好", content: "- 讨厌香菜" },
        { op: "delete_line", section: "喜好", match: "讨厌香菜" },
        { op: "upsert", section: MANUAL_SECTION, content: "- 不该写入" },
        { op: "delete_section", section: "关系" },
      ],
      "user",
    );
    expect(result.changed).toBe(true);
    expect(result.content).toContain("## 基本信息\n- 称呼：鱼片");
    expect(result.content).toContain("## 喜好\n- 喜欢吃白米饭");
    expect(result.content).not.toContain("讨厌香菜");
    expect(result.content).not.toContain("不该写入");
    expect(result.content).not.toContain("## 关系");
    expect(result.changes).toContain("replace 基本信息");
    expect(result.changes).toContain("delete 喜好: 讨厌香菜");
  });

  it("formats a compact prompt document without empty sections", () => {
    const content = normalizeDocument("", "user");
    const formatted = docForPrompt(
      content.replace("## 基本信息", "## 基本信息\n- 称呼：鱼片"),
      500,
    );
    expect(formatted).toContain("## 基本信息\n- 称呼：鱼片");
    expect(formatted).not.toContain("## 喜好");
  });

  it("writes private docs atomically and keeps history", async () => {
    const { root, store } = await setup();
    const ref = { namespace: "p", scope: "private:1", actorQq: 1 };
    const first = normalizeDocument("", "user").replace("## 基本信息", "## 基本信息\n- 称呼：鱼片");
    const written = await store.writeUser(ref, first);
    expect(written.path).toBe(join(root, "p", "private_1", "memory.md"));
    expect((await store.load(ref)).user.content).toContain("称呼：鱼片");

    const second = first.replace("称呼：鱼片", "称呼：小鱼");
    await store.writeUser(ref, second);
    expect((await store.load(ref)).user.content).toContain("称呼：小鱼");
    const history = await store.history(ref, "user");
    expect(history).toHaveLength(1);
    const version = history[0];
    if (version === undefined) throw new Error("missing history version");
    expect(await readFile(version.path, "utf8")).toContain("称呼：鱼片");
    await store.forgetAll(ref);
    expect((await store.load(ref)).user.exists).toBe(false);
  });

  it("stores shared scene and per-user docs under one group directory", async () => {
    const { root, store } = await setup();
    const ref = { namespace: "p", scope: "group:9", actorQq: 2 };
    await store.writeScene(ref, normalizeDocument("", "scene"));
    await store.appendManual(ref, "这是群友二号的记忆");
    const bundle = await store.load(ref);
    expect(bundle.shared).toBe(true);
    expect(bundle.scene?.path).toBe(join(root, "p", "group_9", "scene.md"));
    expect(bundle.user.path).toBe(join(root, "p", "group_9", "users", "2.md"));
    expect(bundle.user.content).toContain("这是群友二号的记忆");
    const all = await store.loadAllUserDocs(ref);
    expect(all.map((doc) => doc.path)).toEqual([join(root, "p", "group_9", "users", "2.md")]);
    expect((await readdir(join(root, "p", "group_9"))).sort()).toEqual([
      "history",
      "scene.md",
      "users",
    ]);
  });

  it("removes sections and whole scopes", async () => {
    const { root, store } = await setup();
    const ref = { namespace: "p", scope: "private:1", actorQq: 1 };
    await store.writeUser(
      ref,
      normalizeDocument("", "user").replace("## 喜好", "## 喜好\n- 白米饭"),
    );
    expect(await store.forgetSection(ref, "喜好")).toBe(true);
    expect((await store.load(ref)).user.content).not.toContain("白米饭");
    expect(await store.forgetSection(ref, MANUAL_SECTION)).toBe(false);
    await store.forgetAll(ref);
    expect((await store.load(ref)).user.exists).toBe(false);
    expect((await readdir(join(root, "p"))).includes("private_1")).toBe(false);
  });
});
