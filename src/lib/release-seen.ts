import { getDb } from '@/lib/db';

const g = globalThis as unknown as { __releaseColReady?: boolean };

/** Idempotent: add users.last_seen_release if missing (once per process, safe on existing DBs). */
function db() {
  const d = getDb();
  if (!g.__releaseColReady) {
    const cols = d.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'last_seen_release')) d.exec('ALTER TABLE users ADD COLUMN last_seen_release TEXT');
    g.__releaseColReady = true;
  }
  return d;
}

export function getLastSeenRelease(userId: number): string | null {
  const r = db().prepare('SELECT last_seen_release AS v FROM users WHERE id = ?').get(userId) as { v: string | null } | undefined;
  return r?.v ?? null;
}

export function setLastSeenRelease(userId: number, id: string) {
  db().prepare('UPDATE users SET last_seen_release = ? WHERE id = ?').run(id, userId);
}
