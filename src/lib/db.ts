import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { isValidHashFormat } from '@/lib/password';
import { ensureInboxSchema, migrateLegacyKeys } from '@/lib/inbox-store';

export type Role = 'admin' | 'lead' | 'agent';
export const ROLES: Role[] = ['admin', 'lead', 'agent'];
export type UserRow = {
  id: number;
  username: string;
  name: string;
  password_hash: string;
  role: Role;
  active: number;
  must_change_password: number;
  session_version: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};
export type PublicUser = Omit<UserRow, 'password_hash' | 'session_version'>;

const g = globalThis as unknown as { __inboxDb?: DatabaseSync };

function init(): DatabaseSync {
  const dir = path.resolve(process.env.DATA_DIR || './data');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'inbox.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','lead','agent')),
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      session_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );
  `);
  migrate(db);
  // Idempotent: per-user read marks (epoch ms) for the unread dot.
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_reads (
      user_id INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,
      last_read_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, conversation_id)
    );
  `);
  // Idempotent: which staff user sent each outgoing message (inbox-only, never sent to WhatsApp).
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_senders (
      wa_message_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      sender_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Idempotent: one row per contact (phone, else @username, else first conversation id). No row = open + unassigned.
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_assignments (
      contact_key TEXT PRIMARY KEY,
      assigned_user_id INTEGER,
      assigned_at INTEGER,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
      resolved_by_user_id INTEGER,
      resolved_by_name TEXT,
      resolved_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);
  // P-009: own message store (contacts, conversations, messages, statuses, meta_events, kv). Idempotent.
  ensureInboxSchema(db);
  try {
    const r = migrateLegacyKeys(db);
    if (r.reads || r.assignments) console.log(`[inbox] rekeyed legacy rows: reads=${r.reads} assignments=${r.assignments}`);
  } catch (e) {
    console.error('[inbox] legacy rekey failed', e instanceof Error ? e.name : 'error');
  }
  bootstrapAdmin(db);
  return db;
}

// v1 -> v2: widen the role CHECK to include 'lead'. SQLite can't alter a CHECK, so rebuild the table.
function migrate(db: DatabaseSync) {
  const t = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get() as { sql: string } | undefined;
  if (!t || t.sql.includes("'lead'")) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','lead','agent')),
        active INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        session_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT
      );
      INSERT INTO users_new (id, username, name, password_hash, role, active, must_change_password, session_version, created_at, updated_at, last_login_at)
        SELECT id, username, name, password_hash, role, active, must_change_password, session_version, created_at, updated_at, last_login_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
    db.exec('COMMIT');
    console.log('[auth] Migrated users table: added lead role.');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function bootstrapAdmin(db: DatabaseSync) {
  const row = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1").get() as { c: number };
  if (row.c > 0) return;
  const username = process.env.ADMIN_USERNAME?.trim();
  const hash = process.env.ADMIN_PASSWORD_HASH?.trim();
  if (!username || !hash || !isValidHashFormat(hash)) {
    console.warn('[auth] No active admin. Set ADMIN_USERNAME and ADMIN_PASSWORD_HASH (npm run hash-password) and restart.');
    return;
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined;
  if (existing) {
    db.prepare("UPDATE users SET role='admin', active=1, password_hash=?, session_version=session_version+1, updated_at=datetime('now') WHERE id=?").run(hash, existing.id);
  } else {
    db.prepare("INSERT INTO users (username, name, password_hash, role) VALUES (?, ?, ?, 'admin')").run(username, process.env.ADMIN_NAME?.trim() || username, hash);
  }
  console.log(`[auth] Bootstrap admin "${username}" ready.`);
}

export function getDb(): DatabaseSync {
  if (!g.__inboxDb) g.__inboxDb = init();
  return g.__inboxDb;
}

export function toPublic(u: UserRow): PublicUser {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password_hash, session_version, ...rest } = u;
  return rest;
}

export function getUserById(id: number): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}
export function getUserByUsername(username: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}
export function countActiveAdmins(): number {
  return (getDb().prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1").get() as { c: number }).c;
}

/** Record the staff user behind an outgoing message. No FK, so rows survive user deletion. */
export function recordMessageSender(waMessageId: string, user: Pick<UserRow, 'id' | 'name' | 'username'>) {
  getDb()
    .prepare('INSERT OR IGNORE INTO message_senders (wa_message_id, user_id, sender_name) VALUES (?, ?, ?)')
    .run(waMessageId, user.id, user.name || user.username);
}

/** Map message id -> current user name, else the saved name snapshot, else 'Usuario eliminado'. */
export function getSenderNames(waMessageIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const ids = [...new Set(waMessageIds.filter((x) => typeof x === 'string' && x))];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = getDb()
      .prepare(
        `SELECT ms.wa_message_id AS id, COALESCE(NULLIF(u.name, ''), NULLIF(u.username, ''), NULLIF(ms.sender_name, ''), 'Usuario eliminado') AS name
         FROM message_senders ms LEFT JOIN users u ON u.id = ms.user_id
         WHERE ms.wa_message_id IN (${chunk.map(() => '?').join(',')})`
      )
      .all(...chunk) as { id: string; name: string | null }[];
    for (const r of rows) out.set(r.id, r.name ?? 'Usuario eliminado');
  }
  return out;
}

/** Extract the WhatsApp message id from a Graph/Kapso send response ({ messages: [{ id }] }). */
export function extractSentMessageId(result: unknown): string | undefined {
  const msgs = (result as { messages?: Array<{ id?: unknown }> } | null)?.messages;
  const id = Array.isArray(msgs) ? msgs[0]?.id : undefined;
  return typeof id === 'string' && id ? id : undefined;
}

export function markConversationsRead(userId: number, conversationIds: string[], at = Date.now()) {
  const stmt = getDb().prepare(
    `INSERT INTO conversation_reads (user_id, conversation_id, last_read_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, conversation_id) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`
  );
  for (const id of conversationIds) stmt.run(userId, id, at);
}

export function getReadMarks(userId: number): Map<string, number> {
  const rows = getDb().prepare('SELECT conversation_id AS id, last_read_at AS at FROM conversation_reads WHERE user_id = ?').all(userId) as { id: string; at: number }[];
  return new Map(rows.map((r) => [r.id, Number(r.at)]));
}
