import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import roleplay from "../../packages/roleplay/src/index.js";
import { importCard } from "../../packages/roleplay/src/persona.js";
import { createPluginHarness, type PluginHarness } from "../../src/plugins/testing.js";

const cardFixture = fileURLToPath(
  new URL("../fixtures/roleplay/blue-fat-fish.card.json", import.meta.url),
);
const pngFixture = fileURLToPath(new URL("../fixtures/red.png", import.meta.url));

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "qq-rp-admin-"));
  const personasDir = join(dataDir, "personas");
  await importCard({ sourcePath: cardFixture, personasDir, id: "blue-fat-fish" });
  const harness: PluginHarness<unknown> = await createPluginHarness(roleplay, {
    dataDir,
    options: {
      project_id: "roleplay",
      agent: "qq-rp",
      install_agent: false,
      personas_dir: personasDir,
      memory_refresh_cooldown_ms: 0,
      memory_consolidate_every_turns: 99,
    },
  });
  disposers.push(async () => harness.dispose());
  return { harness, dataDir, personasDir };
}

function asObject(value: unknown): Record<string, unknown> {
  expect(value).not.toBeInstanceOf(Response);
  return value as Record<string, unknown>;
}

describe("roleplay admin API", () => {
  it("reports a summary and manages personas, notes and worldbook", async () => {
    const { harness, personasDir } = await setup();

    const summary = asObject(await harness.dispatchAdmin("GET", "/summary"));
    expect(summary).toMatchObject({
      personas: { total: 1 },
      paths: { personas: personasDir },
    });
    expect(summary).toHaveProperty("stickers.total");

    const list = asObject(await harness.dispatchAdmin("GET", "/personas"));
    expect(list.personas).toHaveLength(1);
    expect(list.personas[0]).toMatchObject({ id: "blue-fat-fish", name: "蓝色大肥鱼" });

    const cardBytes = await readFile(cardFixture);
    const form = new FormData();
    form.append(
      "file",
      new File([cardBytes], "blue-fat-fish.card.json", {
        type: "application/json",
      }),
    );
    form.append("id", "blue-fat-fish");
    const imported = asObject(
      await harness.dispatchAdmin("POST", "/personas/import", {
        rawBody: form,
      }),
    );
    expect(imported.persona).toMatchObject({ id: "blue-fat-fish" });

    const notes = asObject(
      await harness.dispatchAdmin("PUT", "/personas/blue-fat-fish/notes", {
        body: { notes: "喜欢安静地吃饭。" },
      }),
    );
    expect(notes.notes).toContain("喜欢安静");
    expect(await readFile(join(personasDir, "blue-fat-fish", "notes.md"), "utf8")).toContain(
      "喜欢安静",
    );
    expect(await readFile(join(personasDir, "blue-fat-fish", "AGENTS.md"), "utf8")).toContain(
      "喜欢安静",
    );

    const detail = asObject(await harness.dispatchAdmin("GET", "/personas/blue-fat-fish"));
    expect(detail).toMatchObject({
      persona: { id: "blue-fat-fish", name: "蓝色大肥鱼" },
      notes: "喜欢安静地吃饭。",
    });
    expect(Array.isArray(detail.worldbook)).toBe(true);

    const worldbook = asObject(
      await harness.dispatchAdmin("GET", "/personas/blue-fat-fish/worldbook"),
    );
    const entries = worldbook.entries as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    const updated = asObject(
      await harness.dispatchAdmin("PUT", "/personas/blue-fat-fish/worldbook", {
        body: {
          entries: [
            {
              ...entries[0],
              content: "更新后的世界书内容",
            },
          ],
        },
      }),
    );
    expect(updated.entries).toHaveLength(1);
    expect(await readFile(join(personasDir, "blue-fat-fish", "worldbook.md"), "utf8")).toContain(
      "更新后的世界书内容",
    );
  });

  it("uploads, lists, thumbnails, renames and deletes stickers", async () => {
    const { harness, dataDir } = await setup();
    const png = await readFile(pngFixture);
    const form = new FormData();
    form.append("files", new File([png], "happy.png", { type: "image/png" }));

    const uploaded = asObject(
      await harness.dispatchAdmin("POST", "/personas/blue-fat-fish/stickers/happy", {
        rawBody: form,
      }),
    );
    expect(uploaded.uploaded).toBe(1);
    expect(uploaded.duplicates).toBe(0);
    const files = uploaded.files as Array<Record<string, unknown>>;
    expect(files[0]?.url).toContain("/media/stickers/blue-fat-fish/happy/");

    const listed = asObject(await harness.dispatchAdmin("GET", "/personas/blue-fat-fish/stickers"));
    const emotions = listed.emotions as Array<Record<string, unknown>>;
    const happy = emotions.find((emotion) => emotion.emotion === "happy");
    expect(happy).toBeTruthy();
    const sticker = ((happy?.files ?? []) as Array<Record<string, unknown>>)[0];
    expect(sticker).toBeTruthy();

    const image = await harness.dispatchAdmin(
      "GET",
      `/media/stickers/blue-fat-fish/happy/${String(sticker?.name)}`,
    );
    expect(image).toBeInstanceOf(Response);
    expect((image as Response).headers.get("content-type")).toContain("image/png");

    const thumbnail = await harness.dispatchAdmin(
      "GET",
      `/media/stickers/blue-fat-fish/happy/${String(sticker?.name)}/thumbnail`,
    );
    expect(thumbnail).toBeInstanceOf(Response);
    const thumbBytes = Buffer.from(await (thumbnail as Response).arrayBuffer());
    expect(thumbBytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(thumbBytes.subarray(8, 12).toString("ascii")).toBe("WEBP");

    const duplicate = new FormData();
    duplicate.append("files", new File([png], "happy-again.png", { type: "image/png" }));
    const duplicated = asObject(
      await harness.dispatchAdmin("POST", "/personas/blue-fat-fish/stickers/happy", {
        rawBody: duplicate,
      }),
    );
    expect(duplicated.uploaded).toBe(0);
    expect(duplicated.duplicates).toBe(1);

    const renamed = asObject(
      await harness.dispatchAdmin("PATCH", "/personas/blue-fat-fish/stickers/happy", {
        body: { emotion: "joy" },
      }),
    );
    expect(renamed.emotion).toBe("joy");
    expect(await readdir(join(dataDir, "stickers", "blue-fat-fish", "joy"))).toHaveLength(1);

    const deleted = asObject(
      await harness.dispatchAdmin(
        "DELETE",
        `/personas/blue-fat-fish/stickers/joy/${String(sticker?.name)}`,
      ),
    );
    expect(deleted.deleted).toBe(true);
  });

  it("reads, writes, snapshots and searches memory", async () => {
    const { harness } = await setup();
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });

    const scopes = asObject(
      await harness.dispatchAdmin("GET", "/memory/scopes?persona=blue-fat-fish"),
    );
    expect(Array.isArray(scopes.scopes)).toBe(true);

    const initial = asObject(
      await harness.dispatchAdmin(
        "GET",
        "/memory/document?persona=blue-fat-fish&scope=private_10001&kind=user&actorQq=10001",
      ),
    );
    expect(initial.document).toMatchObject({ exists: false });

    const content = [
      "# 用户记忆",
      "",
      "## 基本信息",
      "- 称呼：鱼片",
      "",
      "## 喜好",
      "- 喜欢吃白米饭",
      "",
      "## 手动记忆",
      "- 手动写入",
      "",
    ].join("\n");
    const saved = asObject(
      await harness.dispatchAdmin("PUT", "/memory/document", {
        body: {
          persona: "blue-fat-fish",
          scope: "private_10001",
          actorQq: 10001,
          kind: "user",
          content,
          allowManual: true,
        },
      }),
    );
    expect(saved.document).toMatchObject({ exists: true });
    expect(String(saved.document.content)).toContain("喜欢吃白米饭");

    await harness.dispatchAdmin("PUT", "/memory/document", {
      body: {
        persona: "blue-fat-fish",
        scope: "private_10001",
        actorQq: 10001,
        kind: "user",
        content: `${content}- 更新一条\n`,
        allowManual: true,
      },
    });

    const history = asObject(
      await harness.dispatchAdmin(
        "GET",
        "/memory/history?persona=blue-fat-fish&scope=private_10001&kind=user&actorQq=10001",
      ),
    );
    const entries = history.history as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);

    const searched = asObject(
      await harness.dispatchAdmin(
        "GET",
        "/memory/search?persona=blue-fat-fish&scope=private_10001&actorQq=10001&q=白米饭",
      ),
    );
    expect(JSON.stringify(searched)).toContain("白米饭");

    const deleted = asObject(
      await harness.dispatchAdmin(
        "DELETE",
        "/memory/scope?persona=blue-fat-fish&scope=private_10001&actorQq=10001",
      ),
    );
    expect(deleted.deleted).toBe(true);
  });

  it("lists and mutates bindings", async () => {
    const { harness } = await setup();
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });

    const list = asObject(await harness.dispatchAdmin("GET", "/bindings"));
    const bindings = list.bindings as Array<Record<string, unknown>>;
    expect(bindings[0]).toMatchObject({
      chatKey: "private:10001",
      personaId: "blue-fat-fish",
      enabled: true,
    });

    const disabled = asObject(
      await harness.dispatchAdmin("PATCH", "/bindings?chatKey=private%3A10001", {
        body: { enabled: false },
      }),
    );
    expect(disabled.binding).toMatchObject({ enabled: false });

    const deleted = asObject(
      await harness.dispatchAdmin("DELETE", "/bindings?chatKey=private%3A10001"),
    );
    expect(deleted.deleted).toBe(true);
    expect(asObject(await harness.dispatchAdmin("GET", "/bindings")).bindings).toHaveLength(0);
  });

  it("rejects path traversal in persona and sticker paths", async () => {
    const { harness } = await setup();
    const persona = await harness.dispatchAdmin("GET", "/personas/..");
    expect(persona).toBeInstanceOf(Response);
    expect((persona as Response).status).toBe(400);

    const sticker = await harness.dispatchAdmin(
      "GET",
      "/media/stickers/blue-fat-fish/happy/..%2Fsecret.png",
    );
    expect(sticker).toBeInstanceOf(Response);
    expect((sticker as Response).status).toBe(404);
  });
});
