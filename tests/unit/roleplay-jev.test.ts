import { describe, expect, it, vi } from "vitest";
import { emotionCriteria, JevEmotionJudge } from "../../packages/roleplay/src/jev.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Jev emotion judge", () => {
  it("asks one Choice + one Noul question and parses typed answers", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: {
          emotion: {
            type: "choice",
            choice: "sad",
            confidence: 0.81,
            probabilities: { sad: 0.83, angry: 0.15, none: 0.02 },
          },
          sticker_ok: { type: "noul", noul: 0.82 },
        },
        usage: { input_tokens: 403, output_tokens: 58, cost: 0.00002 },
      }),
    );
    const judge = new JevEmotionJudge({
      baseUrl: "https://relay.test/v1",
      endpoint: "decisions",
      apiKey: "secret",
      model: "jev-1.13",
      timeoutMs: 1000,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const result = await judge.judge({
      userText: "我今天被老板骂了",
      replyText: "别理那个老板，先坐下吃饭。",
      emotions: ["sad", "angry", "happy"],
    });

    expect(result).toEqual({
      emotion: "sad",
      confidence: 0.81,
      stickerOk: 0.82,
      probabilities: { sad: 0.83, angry: 0.15, none: 0.02 },
      usage: { inputTokens: 403, outputTokens: 58, cost: 0.00002 },
    });
    expect(fetch).toHaveBeenCalledOnce();
    const call = fetch.mock.calls[0];
    if (call === undefined) throw new Error("fetch was not called");
    const [url, init] = call;
    expect(url).toBe("https://relay.test/v1/decisions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    const body = JSON.parse(String(init.body)) as {
      model: string;
      state: Record<string, string>;
      questions: Record<string, { type: string; criteria: Record<string, string> }>;
    };
    expect(body.model).toBe("jev-1.13");
    expect(body.state.user).toContain("老板");
    expect(body.questions.emotion?.type).toBe("choice");
    expect(body.questions.emotion?.criteria).toMatchObject({
      sad: expect.stringContaining("难过"),
      happy: expect.stringContaining("开心"),
      none: expect.any(String),
    });
    expect(body.questions.sticker_ok?.type).toBe("noul");
  });

  it("returns null for none or an unavailable choice", async () => {
    for (const choice of ["none", "sleepy"]) {
      const judge = new JevEmotionJudge({
        baseUrl: "https://relay.test/v1",
        apiKey: "secret",
        model: "jev-1.13",
        timeoutMs: 1000,
        fetch: (async () =>
          jsonResponse({
            answers: {
              emotion: { choice, confidence: 0.9 },
              sticker_ok: { noul: 0.9 },
            },
          })) as unknown as typeof globalThis.fetch,
      });
      const result = await judge.judge({
        userText: "hello",
        replyText: "hi",
        emotions: ["sad", "happy"],
      });
      expect(result.emotion).toBeNull();
    }
  });

  it("raises a typed error for HTTP failures", async () => {
    const judge = new JevEmotionJudge({
      baseUrl: "https://relay.test/v1",
      apiKey: "secret",
      model: "jev-1.13",
      timeoutMs: 1000,
      fetch: (async () =>
        new Response("upstream down", { status: 503 })) as unknown as typeof globalThis.fetch,
    });
    await expect(
      judge.judge({ userText: "hello", replyText: "hi", emotions: ["happy"] }),
    ).rejects.toMatchObject({ name: "JevError", status: 503 });
  });

  it("builds criteria only for available emotions", () => {
    const criteria = emotionCriteria(["happy", "tsundere", "custom"]);
    expect(criteria).toMatchObject({
      happy: expect.stringContaining("开心"),
      tsundere: expect.stringContaining("傲娇"),
      custom: "custom",
      none: expect.any(String),
    });
    expect(criteria.sad).toBeUndefined();
  });

  it("appends asset captions to criteria and sends persona context", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({
        answers: {
          emotion: { choice: "clingy", confidence: 0.9 },
          sticker_ok: { noul: 0.9 },
        },
      }),
    );
    const judge = new JevEmotionJudge({
      baseUrl: "https://relay.test/v1",
      apiKey: "secret",
      model: "jev-1.13",
      timeoutMs: 1000,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await judge.judge({
      userText: "在干嘛呢",
      replyText: "蹭过来贴贴。",
      emotions: ["clingy", "happy"],
      personaName: "蓝色大肥鱼",
      hintEmotion: "clingy",
      emotionHints: { clingy: "蹭枕头/撒娇、碰鼻子/亲昵" },
    });
    const call = fetch.mock.calls[0];
    if (call === undefined) throw new Error("fetch was not called");
    const body = JSON.parse(String(call[1].body)) as {
      state: Record<string, string>;
      questions: { emotion: { criteria: Record<string, string> } };
    };
    expect(body.state.scene).toContain("蓝色大肥鱼");
    expect(body.state.assistant_emotion_suggestion).toBe("clingy");
    expect(body.questions.emotion.criteria.clingy).toContain("撒娇");
    expect(body.questions.emotion.criteria.clingy).toContain("蹭枕头/撒娇");
    expect(body.questions.emotion.criteria.happy).not.toContain("素材");
  });

  it("drops a suggestion that has no sticker assets", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({
        answers: {
          emotion: { choice: "happy", confidence: 0.9 },
          sticker_ok: { noul: 0.9 },
        },
      }),
    );
    const judge = new JevEmotionJudge({
      baseUrl: "https://relay.test/v1",
      apiKey: "secret",
      model: "jev-1.13",
      timeoutMs: 1000,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await judge.judge({
      userText: "hi",
      replyText: "hello",
      emotions: ["happy"],
      hintEmotion: "dance",
    });
    const call = fetch.mock.calls[0];
    if (call === undefined) throw new Error("fetch was not called");
    const body = JSON.parse(String(call[1].body)) as { state: Record<string, string> };
    expect(body.state.assistant_emotion_suggestion).toBeUndefined();
  });
});
