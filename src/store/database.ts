import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/** Open the SQLite file and apply the pragmas shared by every repository. */
export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  let db: Database.Database;
  try {
    db = new Database(path);
  } catch (error) {
    if (isNativeBindingError(error)) {
      throw new Error(
        [
          "SQLite 原生模块 better-sqlite3 没有正确安装（找不到 better_sqlite3.node）。",
          "这通常发生在 npx 缓存不完整，或安装时跳过了 install script。",
          "",
          "修复方式：",
          "  npm cache clean --force",
          "  npm install -g opencode-qq-adapter",
          "",
          "如果仍然失败，请先安装构建工具，然后运行：",
          "  npm rebuild better-sqlite3 --build-from-source",
        ].join("\n"),
        { cause: error },
      );
    }
    throw error;
  }
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }
  return db;
}

function isNativeBindingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Could not locate the bindings file") ||
    message.includes("better_sqlite3.node") ||
    message.includes("Module did not self-register")
  );
}
