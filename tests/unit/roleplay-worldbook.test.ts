import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseCard } from "@character-foundry/character-foundry/loader";
import { describe, expect, it } from "vitest";
import {
  normalizeWorldbook,
  parseStoredWorldbook,
  renderWorldbook,
  selectWorldbook,
  selectWorldbookDetailed,
  type WorldbookEntry,
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
    expect(prioritized.map((entry) => entry.name)).toEqual(["称呼", "体重禁区"]);
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

  it("normalizes match_whole_words from card extensions", () => {
    const list = normalizeWorldbook({
      data: {
        character_book: {
          entries: [
            {
              name: "猫",
              keys: ["cat"],
              content: "A cat.",
              extensions: { match_whole_words: true },
            },
            {
              name: "旧条目",
              keys: ["dog"],
              content: "A dog.",
            },
          ],
        },
      },
    });
    expect(list[0]?.matchWholeWords).toBe(true);
    expect(list[1]?.matchWholeWords).toBeUndefined();
  });

  it("parses old cached worldbook entries without matchWholeWords", () => {
    const old = {
      name: "旧条目",
      keys: ["dog"],
      secondaryKeys: [],
      content: "A dog.",
      enabled: true,
      constant: false,
      selective: false,
      caseSensitive: false,
      priority: 0,
      insertionOrder: 0,
      position: "before_char",
    } as WorldbookEntry;
    expect(parseStoredWorldbook([old])[0]?.matchWholeWords).toBeUndefined();
  });

  it("matches ASCII keys on word boundaries only", () => {
    const list = [
      makeEntry({ name: "猫", keys: ["cat"], content: "A cat.", matchWholeWords: true }),
    ];
    const config = { scanDepth: 2, maxEntries: 4, maxChars: 2000 };
    expect(
      selectWorldbook(list, { currentText: "concatenate", recentTexts: [] }, config),
    ).toHaveLength(0);
    expect(
      selectWorldbook(list, { currentText: "look at that cat.", recentTexts: [] }, config),
    ).toHaveLength(1);
  });

  it("keeps Chinese and mixed keys on substring matching", () => {
    const list = [
      makeEntry({ name: "白饭", keys: ["白饭"], content: "白饭", matchWholeWords: true }),
      makeEntry({ name: "混合", keys: ["Rufus 的骨头"], content: "骨头", matchWholeWords: true }),
    ];
    const config = { scanDepth: 2, maxEntries: 4, maxChars: 2000 };
    expect(
      selectWorldbook(list, { currentText: "我想吃白饭", recentTexts: [] }, config).map(
        (entry) => entry.name,
      ),
    ).toEqual(["白饭"]);
    expect(
      selectWorldbook(list, { currentText: "Rufus 的骨头在这里", recentTexts: [] }, config).map(
        (entry) => entry.name,
      ),
    ).toEqual(["混合"]);
  });

  it("uses the global whole-word option only as a fallback", () => {
    const list = [
      makeEntry({ name: "猫", keys: ["cat"], content: "A cat.", matchWholeWords: undefined }),
      makeEntry({
        name: "狗",
        keys: ["dog"],
        content: "A dog.",
        matchWholeWords: false,
      }),
    ];
    const config = {
      scanDepth: 2,
      maxEntries: 4,
      maxChars: 2000,
      matchWholeWords: true,
    };
    expect(
      selectWorldbook(list, { currentText: "concatenate and catmatic", recentTexts: [] }, config),
    ).toHaveLength(0);
    expect(
      selectWorldbook(list, { currentText: "concatenate and a dog", recentTexts: [] }, config).map(
        (entry) => entry.name,
      ),
    ).toEqual(["狗"]);
  });

  it("recursively activates entries from selected entry content", () => {
    const list = [
      makeEntry({
        name: "Bessie",
        keys: ["Bessie"],
        content: "Bessie is a cow and is friends with Rufus.",
      }),
      makeEntry({ name: "Rufus", keys: ["Rufus"], content: "Rufus is a dog.", priority: 5 }),
    ];
    const context = { currentText: "Bessie", recentTexts: [] };
    const config = { scanDepth: 2, maxEntries: 4, maxChars: 2000, recursionSteps: 1 };
    const trace = selectWorldbookDetailed(list, context, config);
    expect(trace.selected.map((entry) => entry.name)).toEqual(["Bessie", "Rufus"]);
    expect(
      trace.matches.find((match) => match.entry.name === "Rufus")?.primary[0]?.source,
    ).toContain("递归");
    expect(
      selectWorldbook(list, context, { ...config, recursionSteps: 0 }).map((entry) => entry.name),
    ).toEqual(["Bessie"]);
  });

  it("does not recurse past the shared budget", () => {
    const list = [
      makeEntry({ name: "Bessie", keys: ["Bessie"], content: "Bessie knows Rufus." }),
      makeEntry({ name: "Rufus", keys: ["Rufus"], content: "Rufus is a dog." }),
    ];
    const trace = selectWorldbookDetailed(
      list,
      { currentText: "Bessie", recentTexts: [] },
      { scanDepth: 2, maxEntries: 1, maxChars: 2000, recursionSteps: 2 },
    );
    expect(trace.selected.map((entry) => entry.name)).toEqual(["Bessie"]);
    expect(trace.dropped.find((item) => item.entry.name === "Rufus")?.reason).toContain("条目上限");
  });

  it("selects constant entries before priority keyword entries", () => {
    const list = [
      makeEntry({ name: "称呼", keys: [], constant: true, content: "称呼对方为鱼片。" }),
      makeEntry({ name: "体重禁区", keys: ["胖"], content: "不要提体重。", priority: 100 }),
    ];
    const selected = selectWorldbook(
      list,
      { currentText: "你是不是胖了", recentTexts: [] },
      { scanDepth: 2, maxEntries: 2, maxChars: 2000 },
    );
    expect(selected.map((entry) => entry.name)).toEqual(["称呼", "体重禁区"]);
  });

  it("reports where each key matched in the debug trace", () => {
    const list = [
      makeEntry({ name: "白饭", keys: ["白饭"], content: "白饭" }),
      makeEntry({ name: "机箱", keys: ["机箱"], content: "机箱" }),
    ];
    const trace = selectWorldbookDetailed(
      list,
      { currentText: "今天想吃白饭", recentTexts: ["机箱有点热"] },
      { scanDepth: 1, maxEntries: 4, maxChars: 2000 },
    );
    expect(trace.matches.find((match) => match.entry.name === "白饭")?.primary[0]?.source).toBe(
      "当前消息",
    );
    expect(
      trace.matches.find((match) => match.entry.name === "机箱")?.primary[0]?.source,
    ).toContain("最近");
  });
  it("supports SillyTavern-style regex keys", () => {
    const list = [
      makeEntry({ name: "抱怨", keys: ["/(好累|累死了|不想动)/"], content: "安慰他。" }),
      makeEntry({ name: "坏正则", keys: ["/(unclosed/"], content: "兜底按子串。" }),
    ];
    const config = { scanDepth: 2, maxEntries: 4, maxChars: 2000 };
    expect(
      selectWorldbook(list, { currentText: "今天好累啊", recentTexts: [] }, config).map(
        (entry) => entry.name,
      ),
    ).toEqual(["抱怨"]);
    expect(
      selectWorldbook(list, { currentText: "今天好开心", recentTexts: [] }, config),
    ).toHaveLength(0);
  });

  it("honors trigger probability", () => {
    const list = [makeEntry({ name: "随机", keys: ["白饭"], probability: 25 })];
    const config = { scanDepth: 2, maxEntries: 4, maxChars: 2000 };
    const trace = selectWorldbookDetailed(
      list,
      { currentText: "白饭", recentTexts: [] },
      { ...config, random: () => 0.5 },
    );
    expect(trace.selected).toHaveLength(0);
    expect(trace.dropped[0]?.reason).toContain("概率未命中");
    expect(
      selectWorldbook(
        list,
        { currentText: "白饭", recentTexts: [] },
        { ...config, random: () => 0.1 },
      ),
    ).toHaveLength(1);
  });

  it("applies sticky, cooldown and delay timed effects per chat", () => {
    const list = [
      makeEntry({ name: "天气", keys: ["天气"], sticky: 2, cooldown: 2 }),
      makeEntry({ name: "迟到", keys: ["迟到"], delay: 3 }),
    ];
    const config = { scanDepth: 2, maxEntries: 4, maxChars: 2000 };
    const state = new Map();

    // Delay: not enough messages yet.
    expect(
      selectWorldbook(
        list,
        { currentText: "迟到", recentTexts: [] },
        { ...config, messageCount: 1, effectState: state },
      ),
    ).toHaveLength(0);

    // Activation records the effect state.
    const first = selectWorldbook(
      list,
      { currentText: "今天天气不错", recentTexts: [] },
      { ...config, messageCount: 3, effectState: state },
    );
    expect(first.map((entry) => entry.name)).toContain("天气");
    expect(state.get("天气")).toMatchObject({ activatedAt: 3, sticky: 2, cooldown: 2 });

    // Sticky: active without any keyword.
    for (const count of [4, 5]) {
      const stickyTrace = selectWorldbookDetailed(
        list,
        { currentText: "完全无关的话题", recentTexts: [] },
        { ...config, messageCount: count, effectState: state },
      );
      expect(stickyTrace.selected.map((entry) => entry.name)).toContain("天气");
      expect(stickyTrace.matches.find((match) => match.entry.name === "天气")?.sticky).toBe(true);
    }

    // Cooldown: keyword present but blocked.
    for (const count of [6, 7]) {
      expect(
        selectWorldbook(
          list,
          { currentText: "天气真好", recentTexts: [] },
          { ...config, messageCount: count, effectState: state },
        ).map((entry) => entry.name),
      ).not.toContain("天气");
    }

    // Cooldown over: activates again.
    expect(
      selectWorldbook(
        list,
        { currentText: "天气真好", recentTexts: [] },
        { ...config, messageCount: 8, effectState: state },
      ).map((entry) => entry.name),
    ).toContain("天气");
  });

  it("supports SillyTavern selective logic variants", () => {
    const base = {
      keys: ["白饭"],
      secondaryKeys: ["饿", "吃"],
      selective: true,
    };
    const config = { scanDepth: 2, maxEntries: 4, maxChars: 2000 };
    const text = { currentText: "我想吃白饭", recentTexts: [] };
    expect(
      selectWorldbook(
        [makeEntry({ ...base, name: "and_all", selectiveLogic: "and_all" })],
        { currentText: "白饭配饿", recentTexts: [] },
        config,
      ),
    ).toHaveLength(0);
    expect(
      selectWorldbook(
        [makeEntry({ ...base, name: "not_any", selectiveLogic: "not_any" })],
        text,
        config,
      ),
    ).toHaveLength(0);
    expect(
      selectWorldbook(
        [makeEntry({ ...base, name: "not_all", selectiveLogic: "not_all" })],
        { currentText: "白饭又饿又吃", recentTexts: [] },
        config,
      ),
    ).toHaveLength(0);
    expect(
      selectWorldbook(
        [makeEntry({ ...base, name: "not_all passes", selectiveLogic: "not_all" })],
        text,
        config,
      ),
    ).toHaveLength(1);
  });

  it("normalizes SillyTavern timed effects and selective logic from extensions", () => {
    const list = normalizeWorldbook({
      data: {
        character_book: {
          entries: [
            {
              name: "天气",
              keys: ["天气"],
              content: "天气不错。",
              probability: 50,
              extensions: { sticky: 3, cooldown: 2, delay: 2, selective_logic: 3 },
            },
          ],
        },
      },
    });
    expect(list[0]).toMatchObject({
      probability: 50,
      sticky: 3,
      cooldown: 2,
      delay: 2,
      selectiveLogic: "not_all",
    });
  });
});

function makeEntry(overrides: Partial<WorldbookEntry> = {}): WorldbookEntry {
  return {
    name: "条目",
    keys: [],
    secondaryKeys: [],
    content: "内容",
    enabled: true,
    constant: false,
    selective: false,
    caseSensitive: false,
    matchWholeWords: false,
    priority: 0,
    insertionOrder: 0,
    position: "before_char",
    ...overrides,
  };
}
