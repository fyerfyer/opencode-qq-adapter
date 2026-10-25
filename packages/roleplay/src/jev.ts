export type JevFetch = typeof fetch;

export interface JevEmotionJudgeOptions {
  baseUrl: string;
  /** Endpoint path appended to baseUrl, e.g. `decisions` or `systemone`. */
  endpoint?: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetch?: JevFetch;
}

export interface JevEmotionJudgeInput {
  userText: string;
  replyText: string;
  /** Emotion ids that actually have sticker assets. */
  emotions: string[];
}

export interface JevEmotionJudgeResult {
  emotion: string | null;
  confidence: number;
  stickerOk: number;
  probabilities: Record<string, number>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
  } | null;
}

export class JevError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "JevError";
    this.status = status;
  }
}

const EMOTION_DESCRIPTIONS: Record<string, string> = {
  happy: "开心、高兴、兴奋、被夸、庆祝",
  shy: "害羞、脸红、被夸得不好意思、撒娇",
  sad: "难过、委屈、被骂、失落、需要安慰",
  angry: "生气、不满、替对方打抱不平",
  surprised: "惊讶、意外、没想到",
  sleepy: "困、晚安、疲惫",
  smug: "得意、骄傲、调侃",
  thinking: "思考、认真、犹豫",
};

/** Build Choice criteria for the installed sticker set. */
export function emotionCriteria(emotions: string[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const emotion of emotions) {
    criteria[emotion] = EMOTION_DESCRIPTIONS[emotion] ?? emotion;
  }
  criteria.none = "没有明显情绪，或此刻不适合发表情";
  return criteria;
}

/**
 * Small client for Jev-style structured decisions (TypeSafe / OpenRouter /
 * compatible relays). It never generates text; it asks one Choice question and
 * one Noul question and returns the typed answers.
 */
export class JevEmotionJudge {
  readonly #url: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #fetch: JevFetch;

  constructor(options: JevEmotionJudgeOptions) {
    const endpoint = (options.endpoint ?? "decisions").replace(/^\/+|\/+$/g, "");
    this.#url = `${options.baseUrl.replace(/\/+$/, "")}/${endpoint}`;
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#timeoutMs = Math.max(100, Math.floor(options.timeoutMs));
    this.#fetch = options.fetch ?? fetch;
  }

  async judge(input: JevEmotionJudgeInput): Promise<JevEmotionJudgeResult> {
    if (input.emotions.length === 0) {
      return {
        emotion: null,
        confidence: 0,
        stickerOk: 0,
        probabilities: {},
        usage: null,
      };
    }

    const payload = {
      model: this.#model,
      state: {
        scene: "QQ 角色扮演聊天",
        user: input.userText.slice(0, 4000),
        assistant: input.replyText.slice(0, 4000),
      },
      questions: {
        emotion: {
          type: "choice",
          instructions:
            "Which emotion should the character's sticker express in this exchange? Focus on the emotional tone of the user message and the character reply. Choose none if a sticker would feel unnatural.",
          criteria: emotionCriteria(input.emotions),
        },
        sticker_ok: {
          type: "noul",
          instructions: "Would sending an emotion sticker feel natural in this exchange?",
          criteria: {
            true: "A sticker would fit the emotional tone.",
            false: "The reply is neutral, informational, or a sticker would feel forced.",
          },
        },
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new JevError(`Jev request timed out after ${this.#timeoutMs}ms`);
      }
      throw new JevError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new JevError(`Jev HTTP ${response.status}: ${body.slice(0, 300)}`, response.status);
    }

    const data = (await response.json()) as {
      answers?: {
        emotion?: { choice?: unknown; confidence?: unknown; probabilities?: unknown };
        sticker_ok?: { noul?: unknown };
      };
      usage?: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown };
    };
    const choice = data.answers?.emotion?.choice;
    const emotion =
      typeof choice === "string" && input.emotions.includes(choice) ? choice : null;
    const confidence = finiteUnit(data.answers?.emotion?.confidence);
    const stickerOk = finiteUnit(data.answers?.sticker_ok?.noul);
    const probabilities: Record<string, number> = {};
    if (isRecord(data.answers?.emotion?.probabilities)) {
      for (const [key, value] of Object.entries(data.answers.emotion.probabilities)) {
        if (typeof value === "number" && Number.isFinite(value)) probabilities[key] = value;
      }
    }
    const usage = isRecord(data.usage)
      ? {
          inputTokens: finiteNumber(data.usage.input_tokens),
          outputTokens: finiteNumber(data.usage.output_tokens),
          cost:
            typeof data.usage.cost === "number" && Number.isFinite(data.usage.cost)
              ? data.usage.cost
              : null,
        }
      : null;

    return { emotion, confidence, stickerOk, probabilities, usage };
  }
}

function finiteUnit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
