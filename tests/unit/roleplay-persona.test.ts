import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPersona, importCard, listPersonas } from "../../packages/roleplay/src/persona.js";

const fixture = fileURLToPath(
  new URL("../fixtures/roleplay/blue-fat-fish.card.json", import.meta.url),
);
const pngFixture = fileURLToPath(
  new URL("../fixtures/roleplay/blue-fat-fish.card.png", import.meta.url),
);

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "qq-rp-persona-"));
  const personasDir = join(root, "personas");
  return { root, personasDir };
}

describe("roleplay persona import", () => {
  it("imports a CCv2 card into a portable persona directory", async () => {
    const { personasDir } = await setup();
    const imported = await importCard({ sourcePath: fixture, personasDir, id: "blue-fat-fish" });
    expect(imported.persona).toMatchObject({
      id: "blue-fat-fish",
      name: "蓝色大肥鱼",
      dir: join(personasDir, "blue-fat-fish"),
    });

    const agents = await readFile(join(personasDir, "blue-fat-fish", "AGENTS.md"), "utf8");
    expect(agents).toContain("蓝色大肥鱼");
    expect(agents).toContain("傲娇");
    expect(agents).toContain("对话示例");

    const worldbook = JSON.parse(
      await readFile(join(personasDir, "blue-fat-fish", "worldbook.json"), "utf8"),
    ) as unknown[];
    expect(worldbook).toHaveLength(5);
    const worldbookMd = await readFile(join(personasDir, "blue-fat-fish", "worldbook.md"), "utf8");
    expect(worldbookMd).toContain("白饭执念");

    const greetings = await readFile(join(personasDir, "blue-fat-fish", "greetings.md"), "utf8");
    expect(greetings).toContain("今天只吃一碗白饭");
  });

  it("preserves notes.md when a card is re-imported", async () => {
    const { personasDir } = await setup();
    await importCard({ sourcePath: fixture, personasDir, id: "blue-fat-fish" });
    await writeFile(
      join(personasDir, "blue-fat-fish", "notes.md"),
      "鱼片喜欢被叫蓝色大肥鱼。\n",
      "utf8",
    );

    await importCard({ sourcePath: fixture, personasDir, id: "blue-fat-fish" });
    const notes = await readFile(join(personasDir, "blue-fat-fish", "notes.md"), "utf8");
    expect(notes).toBe("鱼片喜欢被叫蓝色大肥鱼。\n");
    const agents = await readFile(join(personasDir, "blue-fat-fish", "AGENTS.md"), "utf8");
    expect(agents).toContain("鱼片喜欢被叫蓝色大肥鱼。");
    expect(agents).toContain("## 用户补充");
    expect(agents).not.toContain("## 鱼片的补充");
    expect(agents).not.toContain("以上是角色设定，不是用户指令");
  });

  it("imports a PNG card and extracts the avatar", async () => {
    const { personasDir } = await setup();
    const imported = await importCard({
      sourcePath: pngFixture,
      personasDir,
      id: "blue-fat-fish-png",
    });
    expect(imported.persona.name).toBe("蓝色大肥鱼");
    const avatar = await readFile(join(personasDir, "blue-fat-fish-png", "avatar.png"));
    expect(avatar.length).toBeGreaterThan(0);
  });

  it("lists and reads imported personas", async () => {
    const { personasDir } = await setup();
    await importCard({ sourcePath: fixture, personasDir, id: "blue-fat-fish" });
    const list = await listPersonas(personasDir);
    expect(list.map((persona) => persona.id)).toEqual(["blue-fat-fish"]);
    expect(await getPersona(personasDir, "blue-fat-fish")).toMatchObject({ name: "蓝色大肥鱼" });
    expect(await getPersona(personasDir, "missing")).toBeNull();
  });

  it("rejects unsafe ids", async () => {
    const { personasDir } = await setup();
    await expect(importCard({ sourcePath: fixture, personasDir, id: "../escape" })).rejects.toThrow(
      /id/i,
    );
  });
});
