import { getDb, type UserRow } from '@/lib/db';

/** Per-contact key (same as the list's conversationKey): phone, else @username, else first Kapso id. */
export { contactKey } from '@/lib/contact-key';

export function isValidKey(k: unknown): k is string {
  return typeof k === 'string' && k.length > 0 && k.length <= 200 && !/[\u0000-\u001f]/.test(k);
}

export type AssignmentStatus = 'open' | 'resolved';
export type Assignment = {
  key: string;
  assignedUserId: number | null;
  assignedName: string | null;
  assignedAt: number | null;
  status: AssignmentStatus;
  resolvedByUserId: number | null;
  resolvedByName: string | null;
  resolvedAt: number | null;
};

const g = globalThis as unknown as { __assignTableReady?: boolean };

/** Ensure the table exists even if the DB singleton was opened before this table was added (dev hot reload). Once per process. */
function db() {
  const d = getDb();
  if (!g.__assignTableReady) {
    d.exec(`
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
    g.__assignTableReady = true;
  }
  return d;
}

type Row = {
  contact_key: string; assigned_user_id: number | null; assigned_at: number | null; status: AssignmentStatus;
  resolved_by_user_id: number | null; resolved_by_name: string | null; resolved_at: number | null;
  assigned_name: string | null; resolver_name: string | null;
};

const SELECT = `SELECT a.*, COALESCE(NULLIF(u.name,''), NULLIF(u.username,''), CASE WHEN a.assigned_user_id IS NOT NULL THEN 'Usuario eliminado' END) AS assigned_name,
  COALESCE(NULLIF(r.name,''), NULLIF(r.username,''), NULLIF(a.resolved_by_name,''), CASE WHEN a.resolved_by_user_id IS NOT NULL THEN 'Usuario eliminado' END) AS resolver_name
  FROM conversation_assignments a LEFT JOIN users u ON u.id = a.assigned_user_id LEFT JOIN users r ON r.id = a.resolved_by_user_id`;

function toAssignment(r: Row): Assignment {
  return {
    key: r.contact_key,
    assignedUserId: r.assigned_user_id ?? null,
    assignedName: r.assigned_user_id != null ? r.assigned_name : null,
    assignedAt: r.assigned_at != null ? Number(r.assigned_at) : null,
    status: r.status,
    resolvedByUserId: r.resolved_by_user_id ?? null,
    resolvedByName: r.resolver_name,
    resolvedAt: r.resolved_at != null ? Number(r.resolved_at) : null,
  };
}

export function emptyAssignment(key: string): Assignment {
  return { key, assignedUserId: null, assignedName: null, assignedAt: null, status: 'open', resolvedByUserId: null, resolvedByName: null, resolvedAt: null };
}

export function getAssignment(key: string): Assignment {
  const r = db().prepare(`${SELECT} WHERE a.contact_key = ?`).get(key) as Row | undefined;
  return r ? toAssignment(r) : emptyAssignment(key);
}

export function getAllAssignments(): Map<string, Assignment> {
  const rows = db().prepare(SELECT).all() as Row[];
  return new Map(rows.map((r) => [r.contact_key, toAssignment(r)]));
}

function upsert(key: string, set: string, params: (string | number | null)[]) {
  const now = Date.now();
  db().prepare(`INSERT INTO conversation_assignments (contact_key, updated_at) VALUES (?, ?) ON CONFLICT(contact_key) DO NOTHING`).run(key, now);
  db().prepare(`UPDATE conversation_assignments SET ${set}, updated_at = ? WHERE contact_key = ?`).run(...params, now, key);
}

export function assignTo(key: string, userId: number | null) {
  upsert(key, 'assigned_user_id = ?, assigned_at = ?', [userId, userId == null ? null : Date.now()]);
}

export function resolve(key: string, by: Pick<UserRow, 'id' | 'name' | 'username'>) {
  upsert(key, "status = 'resolved', resolved_by_user_id = ?, resolved_by_name = ?, resolved_at = ?", [by.id, by.name || by.username, Date.now()]);
}

/** Reopen keeps the assigned agent; clears the resolved record. */
export function reopen(key: string) {
  upsert(key, "status = 'open', resolved_by_user_id = NULL, resolved_by_name = NULL, resolved_at = NULL", []);
}

/** Auto-reopen: a resolved chat whose latest inbound is newer than its resolve time. Returns true if reopened. */
export function reopenIfNewInbound(a: Assignment, latestInboundMs: number): boolean {
  if (a.status !== 'resolved' || !a.resolvedAt || latestInboundMs <= a.resolvedAt) return false;
  const r = db().prepare(`UPDATE conversation_assignments SET status='open', resolved_by_user_id=NULL, resolved_by_name=NULL, resolved_at=NULL, updated_at=? WHERE contact_key=? AND status='resolved' AND resolved_at < ?`).run(Date.now(), a.key, latestInboundMs);
  return Number(r.changes) > 0;
}
