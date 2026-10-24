import { describe, expect, it } from "vitest";
import {
  type DeliveryOptions,
  plainText,
  planReply,
  splitReply,
} from "../../packages/roleplay/src/delivery.js";

const options: DeliveryOptions = {
  maxSegments: 4,
  maxChars: 40,
  delayPerCharMs: 25,
  maxDelayMs: 1200,
};

describe("roleplay delivery", () => {
  it("strips common Markdown without destroying the prose", () => {
    const text =
      "# 标题\n\n**你好**，*鱼片*。\n\n- 第一项\n- 第二项\n\n`code` [链接](https://example.com)";
    expect(plainText(text)).toBe("标题\n\n你好，鱼片。\n\n第一项\n第二项\n\ncode 链接");
  });

  it("splits Chinese prose into ordered sentence groups", () => {
    const text = "第一句。第二句！第三句？第四句……第五句。";
    const segments = splitReply(text, { ...options, maxChars: 12, maxSegments: 4 });
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.join("")).toBe(text);
    expect(segments.every((segment) => segment.length <= 12)).toBe(true);
  });

  it("keeps short replies whole and never returns empty segments", () => {
    expect(splitReply("哼，鱼片。", options)).toEqual(["哼，鱼片。"]);
    expect(splitReply("   ", options)).toEqual([]);
  });

  it("caps the number of segments without dropping text", () => {
    const text = "一。二。三。四。五。六。七。八。九。十。";
    const segments = splitReply(text, { ...options, maxChars: 4, maxSegments: 2 });
    expect(segments).toHaveLength(2);
    expect(segments.join("")).toBe(text);
  });

  it("adds a delay to every segment after the first", () => {
    const plan = planReply("第一句。第二句！", options);
    expect(plan[0]).toEqual({ text: "第一句。" });
    expect(plan[1]?.delayMs).toBeGreaterThan(0);
    expect(plan[1]?.delayMs).toBeLessThanOrEqual(options.maxDelayMs);
  });

  it("splits a short multi-sentence reply into multiple bubbles", () => {
    const text =
      "（尾巴僵了一下）喂，学本鲸说话做什么。说一碗就一碗。鲸鱼说话算话的。（把饭碗搂紧）不过……你要是也没吃，本鲸可以分你半碗。就半碗，别得寸进尺。";
    const segments = splitReply(text, { ...options, maxChars: 180, maxSegments: 4 });
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.length).toBeLessThanOrEqual(4);
    expect(segments.join("")).toBe(text);
  });
});
