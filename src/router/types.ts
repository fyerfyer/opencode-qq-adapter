import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { ConversationManager } from "../conversation/manager.js";
import type { IncomingMessage } from "../domain/message.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { AgentPort } from "../ports/agent.js";
import type { OneBotPort } from "../ports/onebot.js";
import type { MessageSender } from "../qq/sender.js";

export interface CommandContext {
  message: IncomingMessage;
  args: string[];
  rawArgs: string;
}

export type CommandHandler = (context: CommandContext) => Promise<void> | void;

export interface RouterDeps {
  config: AppConfig;
  policy: PolicyEngine;
  conversations: ConversationManager;
  sender: MessageSender;
  agent: AgentPort;
  onebot: OneBotPort;
  logger: Logger;
}
