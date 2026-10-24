import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseCard } from "@character-foundry/character-foundry/loader";
import { describe, expect, it } from "vitest";
import {
  normalizeWorldbook,
  renderWorldbook,
  selectWorldbook,
} from "../../packages/roleplay/src/worldbook.js";

const fixture = fileURLToPath(
  new URL("../fixtures/roleplay/blue-fat-fish.card.json", import.meta.url),
);

async function entries() {
  const parsed = parseCard(await readFile(fixture));
  return normalizeWorldbook(parsed.card);
}

describe("roleplay worldbook", () => {
  it("normalizes card entries", async () => {
    const list = await entries();
    expect(list).toHaveLength(5);
    expect(list.find((entry) => entry.name === "白饭执念")).toMatchObject({
      keys: ["白饭", "米饭", "吃饭", "饿了"],
      enabled: true,
      constant: false,
    });
    expect(list.find((entry) => entry.name === "机箱生态")).toMatchObject({
      selective: true,
      secondaryKeys: ["睡", "尾巴"],
    });
  });

  it("always includes constant entries", async () => {
    const matches = selectWorldbook(
      await entries(),
      { currentText: "今天天气不错", recentTexts: [] },
      {
        scanDepth: 4,
        maxEntries: 4,
        maxChars: 2000,
      },
    );
    expect(matches.map((entry) => entry.name)).toContain("称呼");
  });

  it("matches primary keys case-insensitively", async () => {
    const matches = selectWorldbook(
      await entries(),
      { currentText: "我想吃白饭", recentTexts: [] },
      {
        scanDepth: 4,
        maxEntries: 4,
        maxChars: 2000,
      },
    );
    expect(matches.map((entry) => entry.name)).toContain("白饭执念");
  });

  it("requires a secondary key for selective entries", async () => {
    const list = await entries();
    const onlyPrimary = selectWorldbook(
      list,
      { currentText: "机箱好热", recentTexts: [] },
      {
        scanDepth: 4,
        maxEntries: 4,
        maxChars: 2000,
      },
    );
    expect(onlyPrimary.map((entry) => entry.name)).not.toContain("机箱生态");

    const both = selectWorldbook(
      list,
      { currentText: "机箱好热，尾巴都烫了", recentTexts: [] },
      {
        scanDepth: 4,
        maxEntries: 4,
        maxChars: 2000,
      },
    );
    expect(both.map((entry) => entry.name)).toContain("机箱生态");
  });

  it("honors scan depth, priority and budgets", async () => {
    const list = await entries();
    const matches = selectWorldbook(
      list,
      { currentText: "今天好累", recentTexts: ["白饭真好吃", "机箱的风扇很响"] },
      { scanDepth: 1, maxEntries: 1, maxChars: 2000 },
    );
    expect(matches.map((entry) => entry.name)).not.toContain("白饭执念");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("称呼");

    const prioritized = selectWorldbook(
      list,
      { currentText: "你是不是胖了", recentTexts: [] },
      { scanDepth: 2, maxEntries: 2, maxChars: 2000 },
    );
    expect(prioritized[0]?.name).toBe("体重禁区");
  });

  it("renders matches as a bounded prompt block", async () => {
    const matches = selectWorldbook(
      await entries(),
      { currentText: "白饭", recentTexts: [] },
      {
        scanDepth: 2,
        maxEntries: 2,
        maxChars: 2000,
      },
    );
    const rendered = renderWorldbook(matches);
    expect(rendered).toContain("[世界书]");
    expect(rendered).toContain("白米饭");
    expect(rendered.startsWith("[世界书]")).toBe(true);
  });
});
