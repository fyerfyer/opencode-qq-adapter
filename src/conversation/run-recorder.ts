import type { RunStatus } from "../domain/conversation.js";
import type { StorePort } from "../ports/store.js";
import type { RunHooks, RunMetadata } from "./run-hooks.js";
import type { ActiveRun, RunUsage } from "./types.js";

/** Persist run lifecycle changes and fan them out to manager hooks. */
export class RunRecorder {
  readonly #store: StorePort;
  readonly #hooks: RunHooks;

  constructor(store: StorePort, hooks: RunHooks) {
    this.#store = store;
    this.#hooks = hooks;
  }

  started(active: ActiveRun): void {
    this.#store.runs.setStatus(active.record.id, "running");
    this.#hooks.onStarted?.(active);
  }

  setWorkspace(active: ActiveRun, workspaceId: string): void {
    active.workspaceId = workspaceId;
    active.record.workspaceId = workspaceId;
    this.#store.runs.setWorkspace(active.record.id, workspaceId);
    this.#store.conversations.setWorkspace(active.record.chatKey, workspaceId);
  }

  setSession(active: ActiveRun, sessionId: string): void {
    active.record.sessionId = sessionId;
    this.#store.runs.setSession(active.record.id, sessionId);
  }

  completed(active: ActiveRun, usage: RunUsage | null, metadata: RunMetadata): void {
    this.#finish(active.record.id, "completed", {
      usageJson: usage ? JSON.stringify(usage) : undefined,
    });
    this.#hooks.onFinished?.(active, "completed", usage, null, metadata);
  }

  interrupted(active: ActiveRun, metadata: RunMetadata): void {
    this.#finish(active.record.id, "interrupted", { stopReason: "user" });
    this.#hooks.onFinished?.(active, "interrupted", active.usage, null, metadata);
  }

  failed(active: ActiveRun, error: string, metadata: RunMetadata): void {
    this.#finish(active.record.id, "failed", { error });
    this.#hooks.onFinished?.(active, "failed", active.usage, error, metadata);
    this.#hooks.onRunFailed?.(active, error);
  }

  #finish(
    runId: string,
    status: RunStatus,
    extras: { stopReason?: string; error?: string; usageJson?: string } = {},
  ): void {
    this.#store.runs.finish(runId, {
      status,
      finishedAt: Date.now(),
      ...extras,
    });
  }
}
