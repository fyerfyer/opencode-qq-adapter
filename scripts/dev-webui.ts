#!/usr/bin/env tsx
/**
 * One-command WebUI development:
 *
 *   pnpm dev:webui          # fixture backend + Vite HMR (safe temp data)
 *   pnpm dev:webui --real   # real bridge + Vite HMR (uses config/config.yaml)
 *
 * The fixture backend uses fake OneBot/OpenCode, the real Roleplay plugin and a
 * temporary data directory. Vite proxies /admin/api to it so cookies, CSRF and
 * the plugin admin routes behave exactly like production.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const real = process.argv.includes("--real");
const fixturePort = process.env.WEBUI_FIXTURE_PORT ?? "8790";
const fixturePassword = process.env.WEBUI_FIXTURE_PASSWORD ?? "webui-test-password";
const children = new Set<ChildProcess>();
let stopping = false;

function buildPackages(): void {
  for (const script of ["build:sdk", "build:memory", "build:roleplay"]) {
    console.log(`[dev:webui] ${script}`);
    execFileSync(pnpm, [script], { cwd: root, stdio: "inherit" });
  }
}

function start(command: string, args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
    // Give each dev child its own process group so Ctrl+C can stop pnpm,
    // Vite and the fixture together instead of leaving orphaned listeners.
    detached: process.platform !== "win32",
  });
  children.add(child);
  child.once("exit", (code, _signal) => {
    children.delete(child);
    if (!stopping) shutdown(code ?? 1);
    else if (children.size === 0) process.exit(code ?? 0);
  });
  return child;
}

function signal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      // Negative PID targets the detached process group (pnpm + Vite/fixture).
      process.kill(-child.pid, signal);
    }
  } catch {
    child.kill(signal);
  }
}

function shutdown(code = 0): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) signal(child, "SIGTERM");
  if (children.size === 0) {
    process.exit(code);
    return;
  }
  const timer = setTimeout(() => {
    for (const child of children) signal(child, "SIGKILL");
    process.exit(code);
  }, 3_000);
  timer.unref?.();
}

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

if (real) {
  console.log("[dev:webui] backend: real bridge on :8787");
  start(pnpm, ["dev"]);
  start(pnpm, ["--dir", "packages/webui", "dev"], {
    VITE_ADMIN_API_PROXY: process.env.VITE_ADMIN_API_PROXY ?? "http://127.0.0.1:8787",
  });
} else {
  buildPackages();
  console.log(`[dev:webui] backend: fixture on :${fixturePort}`);
  start(pnpm, ["tsx", "scripts/webui-fixture.ts"], {
    WEBUI_FIXTURE_PORT: fixturePort,
    WEBUI_FIXTURE_PASSWORD: fixturePassword,
  });
  start(pnpm, ["--dir", "packages/webui", "dev"], {
    VITE_ADMIN_API_PROXY: process.env.VITE_ADMIN_API_PROXY ?? `http://127.0.0.1:${fixturePort}`,
  });
}
