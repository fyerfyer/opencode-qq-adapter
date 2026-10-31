import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { WorkspaceLease, WorkspaceRecord } from "../domain/workspace.js";
import type { StorePort } from "../ports/store.js";
import { isPathInside } from "../util/path.js";

const execFileAsync = promisify(execFile);

export class WorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

export class WorkspaceLockAbortedError extends WorkspaceError {
  constructor() {
    super("Workspace lock acquisition aborted");
    this.name = "WorkspaceLockAbortedError";
  }
}

export interface WorkspaceStatus {
  workspace: WorkspaceRecord | null;
  lockedByChatKey: string | null;
  lockedByRunId: string | null;
  leaseExpiresAt: number | null;
}

export interface WorkspaceDiff {
  isGit: boolean;
  text: string;
}

export interface WorkspaceManagerOptions {
  config: AppConfig;
  store: StorePort;
  logger: Logger;
  now?: () => number;
}

/**
 * Shared-workspace locks and leases. This intentionally stays small: M3 uses
 * one shared workspace per project, an in-process wait loop and a persisted
 * lease so a bridge restart can recover stale locks.
 */
export class WorkspaceManager {
  readonly #config: AppConfig;
  readonly #store: StorePort;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #leases = new Map<string, { lease: WorkspaceLease; timer: NodeJS.Timeout }>();

  constructor(options: WorkspaceManagerOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  /** Release locks left by a previous bridge process. */
  recover(): number {
    const released = this.#store.workspaces.recoverLocks(this.#now());
    if (released > 0) {
      this.#logger.warn({ released }, "Released stale workspace locks after restart");
    }
    return released;
  }

  pathFor(projectId: string): string {
    const project = this.#config.projects[projectId];
    if (project === undefined) {
      throw new WorkspaceError(`Project '${projectId}' does not exist`);
    }
    return project.path;
  }

  status(projectId: string): WorkspaceStatus {
    const project = this.#config.projects[projectId];
    if (project?.workspace === "none") {
      return {
        workspace: null,
        lockedByChatKey: null,
        lockedByRunId: null,
        leaseExpiresAt: null,
      };
    }
    const workspace = this.#ensureShared(projectId);
    return {
      workspace,
      lockedByChatKey: workspace.status === "locked" ? workspace.ownerChatKey : null,
      lockedByRunId: workspace.status === "locked" ? workspace.lockedByRunId : null,
      leaseExpiresAt: workspace.status === "locked" ? workspace.leaseExpiresAt : null,
    };
  }

  async acquire(
    projectId: string,
    chatKey: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceLease> {
    const workspace = this.#ensureShared(projectId);
    const leaseMs = this.#config.workspaces.lock_lease_ms;
    let loggedWait = false;
    for (;;) {
      if (signal?.aborted) throw new WorkspaceLockAbortedError();
      const now = this.#now();
      if (this.#store.workspaces.tryLock(workspace.id, runId, chatKey, now, now + leaseMs)) {
        const lease: WorkspaceLease = {
          id: workspace.id,
          projectId,
          path: workspace.path,
          branch: workspace.branch,
          ownerChatKey: chatKey,
          runId,
          leaseExpiresAt: now + leaseMs,
        };
        this.#startRenewal(lease);
        if (loggedWait) {
          this.#logger.info({ projectId, runId, chatKey }, "Workspace lock acquired");
        }
        return lease;
      }
      if (!loggedWait) {
        loggedWait = true;
        this.#logger.info(
          { projectId, runId, chatKey, holder: workspace.ownerChatKey },
          "Workspace is busy; waiting for lock",
        );
      }
      try {
        await delay(200, undefined, { signal });
      } catch {
        throw new WorkspaceLockAbortedError();
      }
    }
  }

  release(lease: WorkspaceLease): void {
    const entry = this.#leases.get(lease.id);
    if (entry !== undefined) {
      clearInterval(entry.timer);
      this.#leases.delete(lease.id);
    }
    this.#store.workspaces.unlock(lease.id, lease.runId, this.#now());
  }

  releaseAll(): void {
    for (const { lease } of [...this.#leases.values()]) {
      this.release(lease);
    }
  }

  /** Release leases that expired without a renewal (for example after a crash). */
  cleanup(): number {
    const released = this.#store.workspaces.releaseExpired(this.#now());
    if (released > 0) {
      this.#logger.warn({ released }, "Released expired workspace leases");
    }
    return released;
  }

  async diff(projectId: string): Promise<WorkspaceDiff> {
    const project = this.#config.projects[projectId];
    if (project?.workspace === "none") return { isGit: false, text: "" };
    const path = this.pathFor(projectId);
    try {
      const inside = await execFileAsync(
        "git",
        ["-C", path, "rev-parse", "--is-inside-work-tree"],
        {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        },
      );
      if (inside.stdout.trim() !== "true") return { isGit: false, text: "" };
    } catch {
      return { isGit: false, text: "" };
    }

    try {
      const [status, diff, staged] = await Promise.all([
        execFileAsync("git", ["-C", path, "status", "--short", "--untracked-files=all"], {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        }),
        execFileAsync("git", ["-C", path, "diff", "--stat", "--no-color"], {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        }),
        execFileAsync("git", ["-C", path, "diff", "--cached", "--stat", "--no-color"], {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        }),
      ]);
      const sections: string[] = [];
      if (status.stdout.trim().length > 0) {
        sections.push(`文件状态：\n${status.stdout.trimEnd()}`);
      }
      const unstaged = diff.stdout.trim();
      if (unstaged.length > 0) sections.push(`未暂存改动：\n${unstaged}`);
      const stagedText = staged.stdout.trim();
      if (stagedText.length > 0) sections.push(`已暂存改动：\n${stagedText}`);
      return { isGit: true, text: sections.join("\n\n") };
    } catch (error) {
      this.#logger.warn({ err: error, projectId }, "Failed to read git diff");
      return { isGit: true, text: "" };
    }
  }

  /** Resolve a path inside a workspace, rejecting symlink escapes. */
  async resolveInside(workspacePath: string, candidate: string): Promise<string> {
    const workspaceReal = await realpath(workspacePath);
    const target = isAbsolute(candidate) ? candidate : join(workspaceReal, candidate);
    const targetReal = await realpath(target);
    if (!isPathInside(workspaceReal, targetReal, { allowRoot: false })) {
      throw new WorkspaceError("Path is outside the workspace");
    }
    return targetReal;
  }

  #ensureShared(projectId: string): WorkspaceRecord {
    const project = this.#config.projects[projectId];
    if (project === undefined) {
      throw new WorkspaceError(`Project '${projectId}' does not exist`);
    }
    const now = this.#now();
    const id = `shared:${projectId}`;
    const existing = this.#store.workspaces.get(id);
    const record: WorkspaceRecord = {
      id,
      projectId,
      kind: "shared",
      path: resolve(project.path),
      branch: null,
      ownerChatKey: existing?.ownerChatKey ?? null,
      status: existing?.status ?? "idle",
      lockedByRunId: existing?.lockedByRunId ?? null,
      leaseExpiresAt: existing?.leaseExpiresAt ?? null,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    };
    this.#store.workspaces.ensure(record);
    return record;
  }

  #startRenewal(lease: WorkspaceLease): void {
    const interval = setInterval(() => {
      const expiresAt = this.#now() + this.#config.workspaces.lock_lease_ms;
      const renewed = this.#store.workspaces.renew(lease.id, lease.runId, expiresAt);
      if (renewed) {
        lease.leaseExpiresAt = expiresAt;
      } else {
        this.#logger.warn(
          { workspaceId: lease.id, runId: lease.runId },
          "Workspace lease renewal failed; another process may have taken it",
        );
      }
    }, this.#config.workspaces.renew_interval_ms);
    interval.unref?.();
    this.#leases.set(lease.id, { lease, timer: interval });
  }
}
