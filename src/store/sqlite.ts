import type Database from "better-sqlite3";
import type { StorePort } from "../ports/store.js";
import { openDatabase } from "./database.js";
import { applyMigrations } from "./migrations.js";
import { createAdminRepository } from "./repositories/admin.js";
import { createApprovalsRepository } from "./repositories/approvals.js";
import { createAuditRepository } from "./repositories/audit.js";
import { createConversationsRepository } from "./repositories/conversations.js";
import { createRunsRepository } from "./repositories/runs.js";
import { createSeenMessagesRepository } from "./repositories/seen-messages.js";
import { createUsageRepository } from "./repositories/usage.js";
import { createWorkspacesRepository } from "./repositories/workspaces.js";

/**
 * SQLite-backed store façade.
 *
 * Schema ownership and SQL live in focused repositories; this class only opens
 * the database, applies migrations and exposes the `StorePort` surface.
 */
export class SqliteStore implements StorePort {
  readonly #db: Database.Database;

  readonly conversations: StorePort["conversations"];
  readonly workspaces: StorePort["workspaces"];
  readonly runs: StorePort["runs"];
  readonly approvals: StorePort["approvals"];
  readonly audit: StorePort["audit"];
  readonly usage: StorePort["usage"];
  readonly seenMessages: StorePort["seenMessages"];
  readonly admin: StorePort["admin"];

  constructor(path: string) {
    this.#db = openDatabase(path);
    applyMigrations(this.#db);
    this.conversations = createConversationsRepository(this.#db);
    this.workspaces = createWorkspacesRepository(this.#db);
    this.runs = createRunsRepository(this.#db);
    this.approvals = createApprovalsRepository(this.#db);
    this.audit = createAuditRepository(this.#db);
    this.usage = createUsageRepository(this.#db);
    this.seenMessages = createSeenMessagesRepository(this.#db);
    this.admin = createAdminRepository(this.#db);
  }

  ping(): boolean {
    try {
      this.#db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.#db.close();
  }
}
