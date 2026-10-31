import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { IncomingMessage } from "../domain/message.js";
import type { MessageSender } from "../qq/sender.js";
import type { ResolvedReplyPlan } from "./reply-plan.js";
import { type ActiveRun, RunStoppedError } from "./types.js";

/** Deliver a plugin-shaped reply plan without letting one bad image abort later segments. */
export class ReplyDelivery {
  readonly #sender: MessageSender;
  readonly #logger: Logger;

  constructor(options: { sender: MessageSender; logger: Logger }) {
    this.#sender = options.sender;
    this.#logger = options.logger;
  }

  async sendPlan(
    message: IncomingMessage,
    active: ActiveRun,
    plan: ResolvedReplyPlan,
  ): Promise<void> {
    if (plan.suppress === true) {
      active.replyText = plan.replyText ?? null;
      return;
    }
    let sentAny = false;
    for (const [index, segment] of plan.segments.entries()) {
      if (active.stopRequested) throw new RunStoppedError();
      if (index > 0 && segment.delayMs !== undefined && segment.delayMs > 0) {
        try {
          await delay(segment.delayMs, undefined, { signal: active.abort.signal });
        } catch {
          throw new RunStoppedError();
        }
        if (active.stopRequested) throw new RunStoppedError();
      }
      if (segment.kind === "text") {
        if (!sentAny) {
          await this.#sender.reply(message.chat, message.id, segment.text);
        } else {
          await this.#sender.send(message.chat, segment.text, { mention: false });
        }
        sentAny = true;
      } else {
        try {
          await this.#sender.sendImage(
            message.chat,
            segment.dataUri,
            segment.caption ?? "",
            sentAny ? { mention: false } : { messageId: message.id },
          );
          sentAny = true;
        } catch (error) {
          this.#logger.warn(
            {
              err: error,
              runId: active.record.id,
              pluginId: segment.pluginId,
              bytes: segment.bytes,
            },
            "Failed to send plugin reply image; continuing",
          );
        }
      }
    }
    if (plan.replyText !== undefined) active.replyText = plan.replyText;
  }
}
