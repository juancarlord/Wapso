// Own message store (P-009 K2). No '@/' imports so node --test can load it directly.
import type { DatabaseSync } from 'node:sqlite';

export type Direction = 'inbound' | 'outbound';
export type Source = 'webhook' | 'send' | 'kapso_export';
export type StoredMessage = {
  waMessageId: string;
  conversationId: string;
  direction: Direction;
  type: string;
  body?: string | null;
  caption?: string | null;
  mediaId?: string | null;
  mediaMime?: string | null;
  mediaSize?: number | null;
  mediaFilename?: string | null;
  mediaPath?: string | null;
  replyTo?: string | null;
  reaction?: string | null;
  templateName?: string | null;
  status?: string | null;
  errorCode?: number | null;
  errorTitle?: string | null;
  ts: number; // epoch ms
  source: Source;
};
export type ContactInput = { key: string; waId?: string | null; phone?: string | null; username?: string | null; name?: string | null; bsuid?: string | null; legacyKapsoId?: string | null };

export function ensureInboxSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      key TEXT PRIMARY KEY, wa_id TEXT, phone TEXT, username TEXT, name TEXT, bsuid TEXT,
      legacy_kapso_id TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, contact_key TEXT NOT NULL REFERENCES contacts(key),
      last_message_at INTEGER, last_inbound_at INTEGER, last_outbound_at INTEGER,
      last_message_preview TEXT, last_message_type TEXT, last_direction TEXT,
      messages_count INTEGER DEFAULT 0, updated_seq INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_conv_last ON conversations(last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conv_seq ON conversations(updated_seq);
    CREATE TABLE IF NOT EXISTS messages (
      wa_message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      direction TEXT CHECK(direction IN ('inbound','outbound')), type TEXT, body TEXT, caption TEXT,
      media_id TEXT, media_path TEXT, media_mime TEXT, media_size INTEGER, media_filename TEXT,
      reply_to TEXT, reaction TEXT, template_name TEXT, status TEXT, error_code INTEGER,
      ts INTEGER NOT NULL, source TEXT CHECK(source IN ('webhook','send','kapso_export')), raw_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv_ts ON messages(conversation_id, ts);
    CREATE INDEX IF NOT EXISTS idx_msg_media ON messages(media_id);
    CREATE TABLE IF NOT EXISTS statuses (
      wa_message_id TEXT, status TEXT, ts INTEGER, error_code INTEGER, PRIMARY KEY (wa_message_id, status)
    );
    CREATE TABLE IF NOT EXISTS meta_events (event_id TEXT PRIMARY KEY, received_at INTEGER);
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS webhook_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, code INTEGER, title TEXT);
    CREATE INDEX IF NOT EXISTS idx_contacts_bsuid ON contacts(bsuid);
    CREATE INDEX IF NOT EXISTS idx_contacts_wa_id ON contacts(wa_id);
  `);
  const cols = (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('error_title')) db.exec('ALTER TABLE messages ADD COLUMN error_title TEXT');
  // Media tiering: 'local' (MEDIA_DIR) or 'bucket' (private bucket, media_object_key). NULL = local.
  if (!cols.includes('media_storage')) db.exec('ALTER TABLE messages ADD COLUMN media_storage TEXT');
  if (!cols.includes('media_object_key')) db.exec('ALTER TABLE messages ADD COLUMN media_object_key TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_media_path ON messages(media_path)');
}

function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function bumpSeq(db: DatabaseSync): number {
  db.prepare("INSERT INTO kv(key,value) VALUES('change_seq','1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();
  return getSeq(db);
}
export function getSeq(db: DatabaseSync): number {
  const r = db.prepare("SELECT value FROM kv WHERE key='change_seq'").get() as { value: string } | undefined;
  return r ? Number(r.value) : 0;
}

export function upsertContact(db: DatabaseSync, c: ContactInput, now = Date.now()) {
  db.prepare(
    `INSERT INTO contacts(key,wa_id,phone,username,name,bsuid,legacy_kapso_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET wa_id=COALESCE(excluded.wa_id,wa_id), phone=COALESCE(excluded.phone,phone),
       username=COALESCE(excluded.username,username), name=COALESCE(excluded.name,name), bsuid=COALESCE(excluded.bsuid,bsuid),
       legacy_kapso_id=COALESCE(legacy_kapso_id,excluded.legacy_kapso_id), updated_at=excluded.updated_at`
  ).run(c.key, c.waId ?? null, c.phone ?? null, c.username ?? null, c.name ?? null, c.bsuid ?? null, c.legacyKapsoId ?? null, now, now);
}

type IdentityChange = { newPhone: string | null; newBsuid: string | null; previousBsuid: string | null };
type KeyRow = { key: string } | undefined;

/** Find the existing contact for an inbound identity so keys (and assignments) stay stable.
 *  Order: BSUID (incl. previous BSUID on a change), then phone/wa_id, then legacy @username. Otherwise the parsed key is new.
 *  On a system identity change the new phone/BSUID is written onto the existing contact. */
export function resolveContact(db: DatabaseSync, c: ContactInput, change?: IdentityChange): ContactInput {
  const byBsuid = (b?: string | null): KeyRow => (b ? db.prepare('SELECT key FROM contacts WHERE bsuid = ? LIMIT 1').get(b) as KeyRow : undefined);
  const byPhone = (p?: string | null): KeyRow => (p ? db.prepare('SELECT key FROM contacts WHERE wa_id = ? OR phone = ? OR key = ? LIMIT 1').get(p, p, p) as KeyRow : undefined);
  const byUser = (u?: string | null): KeyRow => (u ? db.prepare('SELECT key FROM contacts WHERE username = ? OR key = ? LIMIT 1').get(u, `@${u}`) as KeyRow : undefined);
  const row = byBsuid(c.bsuid) ?? byBsuid(change?.previousBsuid) ?? byPhone(c.waId ?? c.phone) ?? byBsuid(change?.newBsuid) ?? byPhone(change?.newPhone) ?? byUser(c.username);
  const out: ContactInput = { ...c, key: row?.key ?? c.key };
  if (change?.newBsuid) out.bsuid = change.newBsuid;
  if (change?.newPhone) {
    out.phone = change.newPhone; out.waId = change.newPhone;
    const other = db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE key != ? AND (wa_id = ? OR phone = ? OR key = ?)').get(out.key, change.newPhone, change.newPhone, change.newPhone) as { n: number };
    if (Number(other.n) > 0) console.warn(`[contacts] number change: new phone already belongs to ${other.n} other contact(s); kept existing key`); // no PII
  }
  return out;
}

export function recordWebhookError(db: DatabaseSync, e: { code: number | null; title: string | null }, now = Date.now()) {
  db.prepare('INSERT INTO webhook_errors(ts,code,title) VALUES(?,?,?)').run(now, e.code, e.title ? e.title.slice(0, 200) : null);
  db.prepare('DELETE FROM webhook_errors WHERE ts < ?').run(now - 30 * 86_400_000);
}

export function previewOf(m: Pick<StoredMessage, 'type' | 'body' | 'caption' | 'reaction' | 'templateName' | 'mediaFilename'>): string {
  if (m.body) return m.body.slice(0, 200);
  if (m.caption) return m.caption.slice(0, 200);
  if (m.reaction) return m.reaction;
  if (m.templateName) return `[Plantilla: ${m.templateName}]`;
  const labels: Record<string, string> = { image: '📷 Imagen', video: '🎥 Video', audio: '🎤 Audio', document: '📄 Documento', sticker: 'Sticker', location: '📍 Ubicación', contacts: '👤 Contacto' };
  return labels[m.type] ?? (m.mediaFilename || `[${m.type}]`);
}

/** Insert once by wa_message_id; replays return false and change nothing. Updates conversation aggregates. */
export function upsertMessage(db: DatabaseSync, contact: ContactInput, m: StoredMessage, raw?: unknown): boolean {
  return tx(db, () => {
    upsertContact(db, contact);
    const r = db.prepare(
      `INSERT INTO messages(wa_message_id,conversation_id,direction,type,body,caption,media_id,media_path,media_mime,media_size,media_filename,
         reply_to,reaction,template_name,status,ts,source,raw_json,error_code,error_title)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(wa_message_id) DO NOTHING`
    ).run(m.waMessageId, m.conversationId, m.direction, m.type, m.body ?? null, m.caption ?? null, m.mediaId ?? null, m.mediaPath ?? null,
      m.mediaMime ?? null, m.mediaSize ?? null, m.mediaFilename ?? null, m.replyTo ?? null, m.reaction ?? null, m.templateName ?? null,
      m.status ?? (m.direction === 'inbound' ? 'received' : 'sent'), m.ts, m.source, raw === undefined ? null : JSON.stringify(raw),
      m.errorCode ?? null, m.errorTitle ?? null);
    if (Number(r.changes) === 0) return false;
    const seq = bumpSeq(db);
    const inbound = m.direction === 'inbound';
    db.prepare(
      `INSERT INTO conversations(id,contact_key,last_message_at,last_inbound_at,last_outbound_at,last_message_preview,last_message_type,last_direction,messages_count,updated_seq)
       VALUES(?,?,?,?,?,?,?,?,1,?)
       ON CONFLICT(id) DO UPDATE SET
         messages_count = messages_count + 1, updated_seq = excluded.updated_seq,
         last_inbound_at = MAX(COALESCE(last_inbound_at,0), COALESCE(excluded.last_inbound_at,0)),
         last_outbound_at = MAX(COALESCE(last_outbound_at,0), COALESCE(excluded.last_outbound_at,0)),
         last_message_preview = CASE WHEN excluded.last_message_at >= COALESCE(last_message_at,0) THEN excluded.last_message_preview ELSE last_message_preview END,
         last_message_type = CASE WHEN excluded.last_message_at >= COALESCE(last_message_at,0) THEN excluded.last_message_type ELSE last_message_type END,
         last_direction = CASE WHEN excluded.last_message_at >= COALESCE(last_message_at,0) THEN excluded.last_direction ELSE last_direction END,
         last_message_at = MAX(COALESCE(last_message_at,0), excluded.last_message_at)`
    ).run(m.conversationId, contact.key, m.ts, inbound ? m.ts : null, inbound ? null : m.ts, previewOf(m), m.type, m.direction, seq);
    return true;
  });
}

const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };
/** Record a status; message status only moves forward (sent < delivered < read), failed is terminal. */
export function applyStatus(db: DatabaseSync, waMessageId: string, status: string, ts: number, errorCode?: number | null): boolean {
  return tx(db, () => {
    const ins = db.prepare('INSERT INTO statuses(wa_message_id,status,ts,error_code) VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
      .run(waMessageId, status, ts, errorCode ?? null);
    if (Number(ins.changes) === 0) return false;
    const cur = db.prepare('SELECT status, conversation_id FROM messages WHERE wa_message_id=?').get(waMessageId) as { status: string | null; conversation_id: string } | undefined;
    if (!cur) return true; // status before message (e.g. sent from elsewhere): kept in statuses
    const next = cur.status === 'failed' ? null
      : status === 'failed' ? 'failed'
      : (RANK[status] ?? 0) > (RANK[cur.status ?? ''] ?? 0) ? status : null;
    if (next) {
      db.prepare('UPDATE messages SET status=?, error_code=COALESCE(?,error_code) WHERE wa_message_id=?').run(next, errorCode ?? null, waMessageId);
      const seq = bumpSeq(db);
      db.prepare('UPDATE conversations SET updated_seq=? WHERE id=?').run(seq, cur.conversation_id);
    }
    return true;
  });
}

/** First-seen check for webhook replays; prunes entries older than 7 days. */
export function seenEvent(db: DatabaseSync, eventId: string, now = Date.now()): boolean {
  db.prepare('DELETE FROM meta_events WHERE received_at < ?').run(now - 7 * 86_400_000);
  const r = db.prepare('INSERT INTO meta_events(event_id,received_at) VALUES(?,?) ON CONFLICT DO NOTHING').run(eventId, now);
  return Number(r.changes) === 0;
}

export function setMediaFile(db: DatabaseSync, waMessageId: string, p: string, mime: string | null, size: number) {
  db.prepare('UPDATE messages SET media_path=?, media_mime=COALESCE(media_mime,?), media_size=?, media_storage=NULL WHERE wa_message_id=?').run(p, mime, size, waMessageId);
}

/** K3: rekey legacy Kapso-id rows (reads by conversation id, assignments by first id) to our ids. Idempotent. */
export function migrateLegacyKeys(db: DatabaseSync): { reads: number; assignments: number } {
  let reads = 0, assignments = 0;
  const hasTable = (n: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n));
  const rows = db.prepare('SELECT c.key, c.legacy_kapso_id AS legacy, v.id AS conv FROM contacts c JOIN conversations v ON v.contact_key=c.key WHERE c.legacy_kapso_id IS NOT NULL').all() as { key: string; legacy: string; conv: string }[];
  tx(db, () => {
    for (const r of rows) {
      for (const legacy of r.legacy.split(',')) {
        if (hasTable('conversation_reads')) {
          reads += Number(db.prepare(`UPDATE OR IGNORE conversation_reads SET conversation_id=? WHERE conversation_id=?`).run(r.conv, legacy).changes);
        }
        if (hasTable('conversation_assignments') && legacy !== r.key) {
          assignments += Number(db.prepare(`UPDATE OR IGNORE conversation_assignments SET contact_key=? WHERE contact_key=?`).run(r.key, legacy).changes);
        }
      }
    }
  });
  return { reads, assignments };
}
