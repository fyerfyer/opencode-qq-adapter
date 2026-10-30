import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planReplyWithSticker } from "../../packages/roleplay/src/delivery.js";
import { writeEmotionAssets } from "../../packages/roleplay/src/persona.js";
import {
  captionHint,
  chooseSticker,
  extractEmotionTag,
  listEmotions,
  loadStickerCatalog,
  normalizeEmotionName,
  stickerCount,
} from "../../packages/roleplay/src/stickers.js";

describe("roleplay emotion tags", () => {
  it("strips valid tags and keeps the last emotion", () => {
    expect(extractEmotionTag("你好[emotion:happy]")).toEqual({
      text: "你好",
      emotion: "happy",
    });
    expect(extractEmotionTag("先这样[emotion:angry]\n\n再见[emotion:SHY]")).toEqual({
      text: "先这样\n\n再见",
      emotion: "shy",
    });
  });

  it("strips invalid tags without selecting a sticker", () => {
    expect(extractEmotionTag("你好[emotion:开心]")).toEqual({
      text: "你好",
      emotion: null,
    });
  });

  it("normalizes card asset names", () => {
    expect(normalizeEmotionName("Happy")).toBe("happy");
    expect(normalizeEmotionName("emotion:very-happy.gif")).toBe("very-happy");
    expect(normalizeEmotionName("开心")).toBeNull();
  });
});

describe("sticker catalog", () => {
  it("loads persona and global assets with persona overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "qq-stickers-"));
    const personaDir = join(root, "blue", "happy");
    const globalDir = join(root, "_global", "happy");
    const shyDir = join(root, "blue", "shy");
    await import("node:fs/promises").then(({ mkdir, writeFile }) =>
      Promise.all([
        mkdir(personaDir, { recursive: true }),
        mkdir(globalDir, { recursive: true }),
        mkdir(shyDir, { recursive: true }),
      ]).then(() =>
        Promise.all([
          writeFile(join(personaDir, "1.gif"), "gif"),
          writeFile(join(globalDir, "global.gif"), "gif"),
          writeFile(join(shyDir, "1.png"), "png"),
          writeFile(join(shyDir, "ignore.txt"), "text"),
        ]),
      ),
    );
    const catalog = await loadStickerCatalog(root, "blue");
    expect(listEmotions(catalog)).toEqual(["happy", "shy"]);
    expect(catalog.emotions.get("happy")).toEqual(["stickers/blue/happy/1.gif"]);
    expect(catalog.emotions.get("shy")).toEqual(["stickers/blue/shy/1.png"]);
    expect(stickerCount(catalog)).toBe(2);
  });

  it("avoids the previous file when alternatives exist", () => {
    const catalog = {
      emotions: new Map([["happy", ["a.gif", "b.gif"]]]),
      captions: new Map<string, string>(),
    };
    const last = new Map<string, string>();
    expect(chooseSticker(catalog, "happy", "chat", last, () => 0)).toBe("a.gif");
    expect(chooseSticker(catalog, "happy", "chat", last, () => 0)).toBe("b.gif");
    expect(chooseSticker(catalog, "missing", "chat", last)).toBeNull();
  });

  it("reads manifest captions and builds per-emotion hints", async () => {
    const root = await mkdtemp(join(tmpdir(), "qq-sticker-captions-"));
    const happyDir = join(root, "blue", "happy");
    await mkdir(happyDir, { recursive: true });
    await writeFile(join(happyDir, "happy-01.gif"), "gif");
    await writeFile(join(happyDir, "happy-02.gif"), "gif");
    await writeFile(
      join(root, "blue", "stickers.json"),
      JSON.stringify({
        stickers: [
          {
            emotion: "happy",
            file: "stickers/blue/happy/happy-01.gif",
            caption: "点赞/认可",
          },
          {
            emotion: "happy",
            file: "stickers/blue/happy/happy-02.gif",
            caption: "耶/开心",
          },
          {
            emotion: "_archive",
            file: "stickers/blue/_archive/rude.gif",
            caption: "倒拇指",
            archived: true,
          },
        ],
      }),
    );
    const catalog = await loadStickerCatalog(root, "blue");
    expect(catalog.captions.get("stickers/blue/happy/happy-01.gif")).toBe("点赞/认可");
    expect(catalog.captions.has("stickers/blue/_archive/rude.gif")).toBe(false);
    expect(captionHint(catalog, "happy")).toBe("点赞/认可、耶/开心");
    expect(captionHint(catalog, "missing")).toBeNull();
    const empty = await loadStickerCatalog(root, "nobody");
    expect(captionHint(empty, "happy")).toBeNull();
  });

  it("extracts CCv3 emotion assets into the plugin data directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "qq-sticker-assets-"));
    const count = await writeEmotionAssets(
      [
        {
          name: "Happy",
          type: "emotion",
          ext: "gif",
          data: Buffer.from("gif"),
        },
        {
          name: "Happy",
          type: "emotion",
          ext: "gif",
          data: Buffer.from("gif2"),
        },
        { name: "icon", type: "icon", ext: "png", data: Buffer.from("png") },
      ],
      "blue",
      root,
    );
    expect(count).toBe(2);
    const files = await readdir(join(root, "blue", "happy"));
    expect(files.sort()).toEqual(["happy-2.gif", "happy.gif"]);
    expect(await readFile(join(root, "blue", "happy", "happy.gif"), "utf8")).toBe("gif");
  });
});

describe("sticker delivery plan", () => {
  const options = {
    maxSegments: 4,
    maxChars: 180,
    delayPerCharMs: 10,
    maxDelayMs: 1000,
  };

  it("appends one image after text with a delay", () => {
    const plan = planReplyWithSticker("第一句。第二句。", options, {
      path: "stickers/blue/happy/1.gif",
      delayMs: 600,
    });
    expect(plan.map((segment) => ("text" in segment ? "text" : "image"))).toEqual([
      "text",
      "text",
      "image",
    ]);
    expect(plan.at(-1)).toMatchObject({
      image: { path: "stickers/blue/happy/1.gif" },
      delayMs: 600,
    });
  });

  it("returns an image-only plan when the text is empty", () => {
    expect(
      planReplyWithSticker("", options, { path: "stickers/blue/happy/1.gif", delayMs: 600 }),
    ).toEqual([{ image: { path: "stickers/blue/happy/1.gif" }, delayMs: 600 }]);
  });

  it("returns an empty plan when text and sticker are both absent", () => {
    expect(planReplyWithSticker("", options, null)).toEqual([]);
  });
});
