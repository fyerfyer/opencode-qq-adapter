import type Database from "better-sqlite3";
import type { DailyUsage } from "../../domain/audit.js";
import type { StorePort, UsageDelta } from "../../ports/store.js";
import { emptyUsage, mapUsage, type UsageRow } from "../rows.js";

export function createUsageRepository(db: Database.Database): StorePort["usage"] {
  return {
    recordPrompt: (day: string, actorQq: number, projectId: string): void => {
      db.prepare(
        `INSERT INTO usage_daily (day, actor_qq, project_id, prompts, input_tokens, output_tokens, cost_usd)
         VALUES (?, ?, ?, 1, 0, 0, 0)
         ON CONFLICT(day, actor_qq, project_id) DO UPDATE SET prompts = prompts + 1`,
      ).run(day, actorQq, projectId);
    },
    addRunUsage: (day: string, actorQq: number, projectId: string, usage: UsageDelta): void => {
      db.prepare(
        `INSERT INTO usage_daily (day, actor_qq, project_id, prompts, input_tokens, output_tokens, cost_usd)
         VALUES (?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(day, actor_qq, project_id) DO UPDATE SET
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cost_usd = cost_usd + excluded.cost_usd`,
      ).run(day, actorQq, projectId, usage.inputTokens, usage.outputTokens, usage.costUsd);
    },
    getDaily: (day: string, actorQq: number, projectId: string): DailyUsage => {
      const row = db
        .prepare("SELECT * FROM usage_daily WHERE day = ? AND actor_qq = ? AND project_id = ?")
        .get(day, actorQq, projectId) as UsageRow | undefined;
      return row ? mapUsage(row) : emptyUsage(day, actorQq, projectId);
    },
    getActorDaily: (day: string, actorQq: number): DailyUsage => {
      const row = db
        .prepare(
          `SELECT ?, ?, '', COALESCE(SUM(prompts), 0) AS prompts,
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(cost_usd), 0) AS cost_usd
           FROM usage_daily WHERE day = ? AND actor_qq = ?`,
        )
        .get(day, actorQq, day, actorQq) as UsageRow;
      return mapUsage({ ...row, project_id: "" });
    },
    getProjectDaily: (day: string, projectId: string): DailyUsage => {
      const row = db
        .prepare(
          `SELECT ?, NULL, ?, COALESCE(SUM(prompts), 0) AS prompts,
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(cost_usd), 0) AS cost_usd
           FROM usage_daily WHERE day = ? AND project_id = ?`,
        )
        .get(day, projectId, day, projectId) as UsageRow;
      return mapUsage({ ...row, actor_qq: 0 });
    },
    listDaily: (day: string): DailyUsage[] => {
      const rows = db
        .prepare("SELECT * FROM usage_daily WHERE day = ? ORDER BY cost_usd DESC, prompts DESC")
        .all(day) as UsageRow[];
      return rows.map(mapUsage);
    },
    recordEvent: (ts: number, actorQq: number, projectId: string, kind: string): void => {
      db.prepare(
        "INSERT INTO usage_events (ts, actor_qq, project_id, kind) VALUES (?, ?, ?, ?)",
      ).run(ts, actorQq, projectId, kind);
    },
    countEvents: (actorQq: number, kind: string, since: number): number => {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS count FROM usage_events WHERE actor_qq = ? AND kind = ? AND ts >= ?",
        )
        .get(actorQq, kind, since) as { count: number };
      return row.count;
    },
    pruneEvents: (before: number): number => {
      const result = db.prepare("DELETE FROM usage_events WHERE ts < ?").run(before);
      return result.changes;
    },
  };
}
