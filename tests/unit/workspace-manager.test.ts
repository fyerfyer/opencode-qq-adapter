import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLogger } from "../../src/observability/logger.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { WorkspaceLockAbortedError, WorkspaceManager } from "../../src/workspace/manager.js";
import { makeTestConfig } from "../helpers/fakes.js";

const disposers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function setup() {
  const projectPath = await mkdtemp(join(tmpdir(), "qq-ws-"));
  const config = makeTestConfig({ projectPath });
  config.workspaces.lock_lease_ms = 5000;
  config.workspaces.renew_interval_ms = 1000;
  const store = new SqliteStore(":memory:");
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const manager = new WorkspaceManager({ config, store, logger });
  disposers.push(() => {
    manager.releaseAll();
    store.close();
    logger.flush?.();
  });
  return { projectPath, config, store, manager };
}

describe("WorkspaceManager", () => {
  it("locks and releases a shared workspace", async () => {
    const { manager } = await setup();
    const lease = await manager.acquire("demo", "private:20000", "run-1");
    expect(lease.path).toBeTruthy();
    expect(manager.status("demo").workspace?.status).toBe("locked");
    expect(manager.status("demo").lockedByChatKey).toBe("private:20000");

    manager.release(lease);
    expect(manager.status("demo").workspace?.status).toBe("idle");
  });

  it("serializes two chats that share the same workspace", async () => {
    const { manager } = await setup();
    const first = await manager.acquire("demo", "private:1", "run-1");
    let secondAcquired = false;
    const secondPromise = manager.acquire("demo", "private:2", "run-2").then((lease) => {
      secondAcquired = true;
      return lease;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(secondAcquired).toBe(false);
    expect(manager.status("demo").lockedByRunId).toBe("run-1");

    manager.release(first);
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    expect(manager.status("demo").lockedByRunId).toBe("run-2");
    manager.release(second);
  });

  it("aborts a waiting run when the command is stopped", async () => {
    const { manager } = await setup();
    const first = await manager.acquire("demo", "private:1", "run-1");
    const controller = new AbortController();
    const waiting = manager.acquire("demo", "private:2", "run-2", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(WorkspaceLockAbortedError);
    manager.release(first);
  });

  it("recovers a lock left by a previous process", async () => {
    const { store, manager } = await setup();
    manager.status("demo");
    store.workspaces.tryLock(
      "shared:demo",
      "run-old",
      "private:9",
      Date.now(),
      Date.now() + 60_000,
    );
    expect(store.workspaces.get("shared:demo")?.status).toBe("locked");

    expect(manager.recover()).toBe(1);
    expect(manager.status("demo").workspace?.status).toBe("idle");
  });

  it("rejects paths that escape the workspace through a symlink", async () => {
    const { projectPath, manager } = await setup();
    const outside = await mkdtemp(join(tmpdir(), "qq-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await mkdir(join(projectPath, "sub"), { recursive: true });
    await symlink(join(outside, "secret.txt"), join(projectPath, "sub", "link.txt"));

    await expect(manager.resolveInside(projectPath, "sub/link.txt")).rejects.toThrow(
      /outside the workspace/,
    );
    const inside = join(projectPath, "sub", "ok.txt");
    await writeFile(inside, "ok");
    await expect(manager.resolveInside(projectPath, "sub/ok.txt")).resolves.toBe(inside);
  });

  it("does not create a shared workspace for lock-free projects", async () => {
    const { config, manager } = await setup();
    const demo = config.projects.demo;
    if (demo === undefined) throw new Error("demo project missing");
    config.projects.demo = { ...demo, workspace: "none" };
    expect(manager.status("demo").workspace).toBeNull();
    await expect(manager.diff("demo")).resolves.toEqual({ isGit: false, text: "" });
  });

  it("reports a non-git workspace as such", async () => {
    const { manager } = await setup();
    const diff = await manager.diff("demo");
    expect(diff).toEqual({ isGit: false, text: "" });
  });
});
