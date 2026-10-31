import type Database from "better-sqlite3";
import type { AdminSessionInput, AdminSessionRecord, AdminUserRecord } from "../../domain/admin.js";
import type { StorePort } from "../../ports/store.js";
import { type AdminSessionRow, type AdminUserRow, mapAdminSession, mapAdminUser } from "../rows.js";

export function createAdminRepository(db: Database.Database): StorePort["admin"] {
  return {
    getUser: (username: string): AdminUserRecord | null => {
      const row = db.prepare("SELECT * FROM admin_users WHERE username = ?").get(username) as
        | AdminUserRow
        | undefined;
      return row ? mapAdminUser(row) : null;
    },
    createUser: (record: AdminUserRecord): void => {
      db.prepare(
        `INSERT INTO admin_users
           (username, password_hash, must_change_password, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        record.username,
        record.passwordHash,
        record.mustChangePassword ? 1 : 0,
        record.createdAt,
        record.updatedAt,
      );
    },
    updatePassword: (
      username: string,
      passwordHash: string,
      mustChange: boolean,
      now: number,
    ): void => {
      db.prepare(
        `UPDATE admin_users
         SET password_hash = ?, must_change_password = ?, updated_at = ?
         WHERE username = ?`,
      ).run(passwordHash, mustChange ? 1 : 0, now, username);
    },
    createSession: (record: AdminSessionInput): void => {
      db.prepare(
        `INSERT INTO admin_sessions
           (token_hash, username, csrf_token, created_at, expires_at, last_seen_at, user_agent, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.tokenHash,
        record.username,
        record.csrfToken,
        record.createdAt,
        record.expiresAt,
        record.createdAt,
        record.userAgent,
        record.ip,
      );
    },
    getSession: (tokenHash: string): AdminSessionRecord | null => {
      const row = db.prepare("SELECT * FROM admin_sessions WHERE token_hash = ?").get(tokenHash) as
        | AdminSessionRow
        | undefined;
      return row ? mapAdminSession(row) : null;
    },
    touchSession: (tokenHash: string, lastSeenAt: number, expiresAt: number): void => {
      db.prepare(
        "UPDATE admin_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
      ).run(lastSeenAt, expiresAt, tokenHash);
    },
    deleteSession: (tokenHash: string): void => {
      db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(tokenHash);
    },
    deleteSessions: (username?: string): number => {
      const result =
        username === undefined
          ? db.prepare("DELETE FROM admin_sessions").run()
          : db.prepare("DELETE FROM admin_sessions WHERE username = ?").run(username);
      return result.changes;
    },
    pruneSessions: (now: number): number => {
      const result = db.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").run(now);
      return result.changes;
    },
  };
}
