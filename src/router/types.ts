import type { Logger } from "pino";
import type { ApprovalBroker } from "../approval/broker.js";
import type { ConfigReloadResult } from "../config/reload.js";
import type { AppConfig } from "../config/schema.js";
import type { ConversationManager } from "../conversation/manager.js";
import type { QuoteResolver } from "../conversation/quote-resolver.js";
import type { IncomingMessage } from "../domain/message.js";
import type { InboundMediaService } from "../media/inbound.js";
import type { AuditTrail } from "../observability/audit.js";
import type { OwnerNotifier } from "../observability/notifier.js";
import type { PluginHost } from "../plugins/host.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { QuotaService } from "../policy/quota.js";
import type { AgentPort } from "../ports/agent.js";
import type { OneBotPort } from "../ports/onebot.js";
import type { MessageSender } from "../qq/sender.js";
import type { SudoService } from "../security/sudo.js";
import type { WorkspaceManager } from "../workspace/manager.js";

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
  approvals: ApprovalBroker;
  quota: QuotaService;
  audit: AuditTrail;
  quotes: QuoteResolver;
  sender: MessageSender;
  agent: AgentPort;
  onebot: OneBotPort;
  media: InboundMediaService;
  workspaces: WorkspaceManager;
  sudo: SudoService;
  notifier: OwnerNotifier;
  plugins?: PluginHost;
  logger: Logger;
  reloadConfig?: () => Promise<ConfigReloadResult>;
}
