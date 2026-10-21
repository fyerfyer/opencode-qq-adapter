import type { Logger } from "pino";
import type { AuditEntry, AuditRecord } from "../domain/audit.js";
import type { StorePort } from "../ports/store.js";

/** Best-effort audit writer. Audit failures must never break message handling. */
export class AuditTrail {
  readonly #store: StorePort;
  readonly #logger: Logger;

  constructor(store: StorePort, logger: Logger) {
    this.#store = store;
    this.#logger = logger;
  }

  record(entry: AuditEntry): void {
    try {
      this.#store.audit.record(entry);
    } catch (error) {
      this.#logger.warn({ err: error, action: entry.action }, "Failed to write audit event");
    }
  }

  listRecent(limit: number): AuditRecord[] {
    try {
      return this.#store.audit.listRecent(limit);
    } catch (error) {
      this.#logger.warn({ err: error }, "Failed to read audit log");
      return [];
    }
  }

  prune(retentionDays: number, now = Date.now()): number {
    try {
      return this.#store.audit.prune(now - retentionDays * 24 * 60 * 60 * 1000);
    } catch (error) {
      this.#logger.warn({ err: error }, "Failed to prune audit log");
      return 0;
    }
  }
}
