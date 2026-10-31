import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { IncomingMessage } from "../domain/message.js";
import type { MessageSender } from "../qq/sender.js";

export interface ProgressState {
  timer: NodeJS.Timeout | null;
  interval: NodeJS.Timeout | null;
  sending: Promise<void> | null;
  messageId: string | null;
  startedAt: number;
  closed: boolean;
}

/** Send and clean up the optional "still working" progress message. */
export class ProgressReporter {
  readonly #config: AppConfig;
  readonly #sender: MessageSender;
  readonly #logger: Logger;

  constructor(options: { config: AppConfig; sender: MessageSender; logger: Logger }) {
    this.#config = options.config;
    this.#sender = options.sender;
    this.#logger = options.logger;
  }

  start(message: IncomingMessage): ProgressState {
    const state: ProgressState = {
      timer: null,
      interval: null,
      sending: null,
      messageId: null,
      startedAt: Date.now(),
      closed: false,
    };
    if (!this.#config.qq.progress_ack) return state;

    state.timer = setTimeout(() => {
      state.timer = null;
      void this.#send(message, state, true);
      const interval = this.#config.qq.progress_interval_ms;
      if (interval > 0) {
        state.interval = setInterval(() => {
          void this.#send(message, state, false);
        }, interval);
        state.interval.unref?.();
      }
    }, this.#config.qq.progress_delay_ms);
    state.timer.unref?.();
    return state;
  }

  async cleanup(message: IncomingMessage, state: ProgressState): Promise<void> {
    state.closed = true;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.interval !== null) {
      clearInterval(state.interval);
      state.interval = null;
    }
    if (state.sending !== null) {
      await state.sending.catch(() => undefined);
    }
    if (state.messageId !== null) {
      await this.#sender.delete(message.chat, state.messageId);
      state.messageId = null;
    }
  }

  async #send(message: IncomingMessage, state: ProgressState, initial: boolean): Promise<void> {
    if (state.closed || state.sending !== null) return;
    const elapsed = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000));
    state.sending = (async () => {
      if (!initial && state.messageId !== null) {
        await this.#sender.delete(message.chat, state.messageId);
        state.messageId = null;
      }
      const text = initial ? "⏳ 正在处理…" : `⏳ 仍在处理…（已 ${elapsed} 秒）`;
      const result = initial
        ? await this.#sender.reply(message.chat, message.id, text)
        : await this.#sender.send(message.chat, text, { mention: false });
      state.messageId =
        result.messageId !== null && result.messageId.length > 0 ? result.messageId : null;
    })()
      .catch((error) => {
        this.#logger.debug({ err: error, chatKey: message.chat.chatKey }, "Progress ack failed");
      })
      .finally(() => {
        state.sending = null;
      });
    await state.sending;
  }
}
