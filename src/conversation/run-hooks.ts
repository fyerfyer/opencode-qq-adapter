import type { RunStatus } from "../domain/conversation.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { ResolvedReplyPlan } from "./reply-plan.js";
import type { ActiveRun, RunUsage } from "./types.js";

export interface RunMetadata {
  agent: string | null;
  model: string | null;
}

export interface RunHooks {
  workspaces: WorkspaceManager;
  bindSession(sessionId: string, active: ActiveRun): void;
  unbindSession(sessionId: string): void;
  formatReply?(active: ActiveRun, text: string): Promise<ResolvedReplyPlan | null>;
  onStarted?(active: ActiveRun): void;
  onSession?(
    active: ActiveRun,
    session: { id: string; agent: string | null; model: string | null },
  ): void;
  onFinished?(
    active: ActiveRun,
    status: RunStatus,
    usage: RunUsage | null,
    error: string | null,
    metadata?: RunMetadata,
  ): void;
  onRunFailed?(active: ActiveRun, error: string): void;
}
