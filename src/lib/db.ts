import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { isValidHashFormat } from '@/lib/password';

export type Role = 'admin' | 'agent';
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
      role TEXT NOT NULL CHECK (role IN ('admin','agent')),
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      session_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );
  `);
  bootstrapAdmin(db);
  return db;
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
