import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string;
  outcome: string;
  detail?: string;
}

export interface SessionRow {
  id_hash: string;
  login: string;
  created_at: number;
  last_seen_at: number;
  reauth_at: number;
  expires_at: number;
}

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      outcome TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
    CREATE INDEX IF NOT EXISTS audit_actor ON audit (actor, id);
    CREATE INDEX IF NOT EXISTS audit_action_outcome ON audit (action, outcome, id);
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY,
      login TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      reauth_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);
  `);
  return db;
}

export function openDataDb(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  return openDb(join(dataDir, "panel.sqlite"));
}

const clip = (v: string | undefined, max: number): string | null => (v === undefined ? null : v.length > max ? `${v.slice(0, max - 1)}…` : v);

export const AUDIT_TARGET_MAX = 200;
export const AUDIT_DETAIL_MAX = 1000;

export function audit(db: Database, entry: AuditEntry, now = Date.now()): void {
  db.query(
    "INSERT INTO audit (ts, actor, action, target, outcome, detail) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(now, entry.actor, entry.action, clip(entry.target, AUDIT_TARGET_MAX), entry.outcome, clip(entry.detail, AUDIT_DETAIL_MAX));
}

export function trimAudit(db: Database, actor: string, keep: number): void {
  db.query(
    "DELETE FROM audit WHERE actor = ? AND id <= (SELECT id FROM audit WHERE actor = ? ORDER BY id DESC LIMIT 1 OFFSET ?)",
  ).run(actor, actor, keep);
}

export function trimAuditOutcome(db: Database, action: string, outcome: string, keep: number): void {
  db.query(
    "DELETE FROM audit WHERE action = ? AND outcome = ? AND id <= (SELECT id FROM audit WHERE action = ? AND outcome = ? ORDER BY id DESC LIMIT 1 OFFSET ?)",
  ).run(action, outcome, action, outcome, keep);
}

export function insertSession(
db: Database, row: SessionRow): void {
  db.query(
    "INSERT INTO sessions (id_hash, login, created_at, last_seen_at, reauth_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(row.id_hash, row.login, row.created_at, row.last_seen_at, row.reauth_at, row.expires_at);
}

export function findSession(db: Database, idHash: string, now: number): SessionRow | null {
  const row = db
    .query<SessionRow, [string, number]>("SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?")
    .get(idHash, now);
  return row ?? null;
}

export function touchSession(db: Database, idHash: string, now: number): void {
  db.query("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").run(now, idHash);
}

export function markReauth(db: Database, idHash: string, now: number): void {
  db.query("UPDATE sessions SET reauth_at = ?, last_seen_at = ? WHERE id_hash = ?").run(now, now, idHash);
}

export function deleteSession(db: Database, idHash: string): void {
  db.query("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
}

export function purgeExpiredSessions(db: Database, now: number): void {
  db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now);
}
