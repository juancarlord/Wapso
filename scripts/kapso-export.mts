// One-time Kapso -> own store export (P-009 K9). Read-only against Kapso (GETs only).
//   npm run kapso:export -- --dry-run [--deep]   no writes, no downloads; counts (+ media size with --deep)
//   npm run kapso:export                          full export (idempotent; rerun inserts 0)
//   npm run kapso:export -- --since=2026-10-20T23:00:00Z   delta
//   --no-media   skip media downloads
//   --cutover    (KC3 gap fill) inserted inbound messages go to the "Fuera de turno" queue flagged cutover; never auto-replied
// Logs counts and ids only, never phone numbers, names or bodies.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WhatsAppClient, buildKapsoFields } from '@kapso/whatsapp-cloud-api';
import { ensureInboxSchema, upsertMessage, setMediaFile, type StoredMessage } from '../src/lib/inbox-store.ts';
import { storeBytes, mediaDir } from '../src/lib/media-store.ts';
import { ensureShiftSchema, markOffShift } from '../src/lib/shift.ts';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const args = new Set(process.argv.slice(2).filter((a) => !a.startsWith('--since=')));
const DRY = args.has('--dry-run');
const DEEP = args.has('--deep') || !DRY;
const NO_MEDIA = args.has('--no-media');
const CUTOVER = args.has('--cutover');
const sinceArg = process.argv.find((a) => a.startsWith('--since='))?.slice(8);
const SINCE = sinceArg ? Date.parse(sinceArg) : 0;
if (sinceArg && !Number.isFinite(SINCE)) { console.error('bad --since'); process.exit(2); }
const PNID = process.env.PHONE_NUMBER_ID;
if (!process.env.KAPSO_API_KEY || !PNID) { console.error('KAPSO_API_KEY and PHONE_NUMBER_ID required'); process.exit(2); }

const kapso = new WhatsAppClient({ baseUrl: 'https://api.kapso.ai/meta/whatsapp', kapsoApiKey: process.env.KAPSO_API_KEY, graphVersion: 'v24.0' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { calls++; return await fn(); } catch (e) {
      const st = (e as { status?: number; httpStatus?: number }).status ?? (e as { httpStatus?: number }).httpStatus;
      if (i >= 5 || (st && st < 500 && st !== 429)) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = Record<string, any>;
const nextCursor = (p: Any | undefined) => (p?.cursors?.after && p?.next !== null ? p.cursors.after : typeof p?.next === 'string' ? new URL(p.next).searchParams.get('after') : null) as string | null;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
export const keyOf = (phone: string | null, username: string | null, id: string) => (phone ? phone.replace(/^\+/, '') : '') || (username ? `@${username}` : '') || id;
const MEDIA = ['image', 'video', 'audio', 'document', 'sticker'];

/** Kapso message -> StoredMessage (same fields the messages route reads). */
export function mapKapsoMessage(m: Any, conversationId: string): StoredMessage {
  const k = m.kapso ?? {};
  const type = str(m.type) ?? 'unknown';
  const md = MEDIA.includes(type) ? m[type] ?? {} : {};
  const content = typeof k.content === 'string' ? k.content : str(k.content?.text);
  const ts = Number(m.timestamp) ? Number(m.timestamp) * 1000 : Date.parse(k.lastMessageTimestamp ?? '') || 0;
  return {
    waMessageId: String(m.id), conversationId, type,
    direction: k.direction === 'outbound' ? 'outbound' : 'inbound',
    body: str(m.text?.body) ?? (MEDIA.includes(type) ? null : content),
    caption: str(md.caption),
    mediaId: str(md.id) ?? str(k.mediaData?.id),
    mediaMime: str(md.mime_type) ?? str(k.mediaData?.contentType) ?? str(k.messageTypeData?.mimeType),
    mediaSize: typeof k.mediaData?.byteSize === 'number' ? k.mediaData.byteSize : null,
    mediaFilename: str(md.filename) ?? str(k.mediaData?.filename) ?? str(k.messageTypeData?.filename),
    reaction: str(m.reaction?.emoji), replyTo: str(m.reaction?.message_id) ?? str(m.context?.id),
    templateName: str(m.template?.name),
    status: str(k.status), ts, source: 'kapso_export',
  };
}

const fields = buildKapsoFields(['direction', 'status', 'has_media', 'media_data', 'media_url', 'message_type_data', 'content', 'contact_name']);
const t0 = Date.now();
let db: DatabaseSync | null = null;
if (!DRY) {
  const dir = path.resolve(process.env.DATA_DIR || './data');
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, 'inbox.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  ensureInboxSchema(db); ensureShiftSchema(db);
}

const tot = { conversations: 0, contacts: new Set<string>(), kapsoMessagesCount: 0, messages: 0, inserted: 0, media: 0, mediaBytes: 0, mediaUnknownSize: 0, downloaded: 0, mediaFailed: 0,
  phonePlus: 0, phoneDigits: 0, usernameOnly: 0, idOnly: 0, mismatches: [] as { id: string; kapso: number; seen: number }[] };
let after: string | null = null;
do {
  const page: Any = await withRetry(() => kapso.conversations.list({ phoneNumberId: PNID, limit: 100, ...(after && { after }),
    fields: buildKapsoFields(['contact_name', 'messages_count', 'last_message_text', 'last_inbound_at', 'last_outbound_at']) }));
  for (const c of page.data ?? []) {
    tot.conversations++;
    const phone = str(c.phoneNumber); const username = str(c.username);
    if (phone?.startsWith('+')) tot.phonePlus++; else if (phone) tot.phoneDigits++; else if (username) tot.usernameOnly++; else tot.idOnly++;
    const key = keyOf(phone, username, String(c.id));
    tot.contacts.add(key);
    const expected = Number(c.kapso?.messagesCount ?? 0);
    tot.kapsoMessagesCount += expected;
    if (!DEEP) continue;
    if (db) {
      db.prepare(`INSERT INTO contacts(key,wa_id,phone,username,name,bsuid,legacy_kapso_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET name=COALESCE(name,excluded.name), username=COALESCE(username,excluded.username),
        legacy_kapso_id=CASE WHEN legacy_kapso_id IS NULL THEN excluded.legacy_kapso_id WHEN instr(','||legacy_kapso_id||',', ','||excluded.legacy_kapso_id||',')>0 THEN legacy_kapso_id ELSE legacy_kapso_id||','||excluded.legacy_kapso_id END`)
        .run(key, phone?.replace(/^\+/, '') ?? null, phone?.replace(/^\+/, '') ?? null, username, str(c.kapso?.contactName), str(c.businessScopedUserId), String(c.id), Date.now(), Date.now());
    }
    let seen = 0; let mAfter: string | null = null; let stop = false;
    do {
      await sleep(300);
      const mp: Any = await withRetry(() => kapso.messages.listByConversation({ phoneNumberId: PNID, conversationId: String(c.id), limit: 100, fields, ...(mAfter && { after: mAfter }) }));
      for (const raw of mp.data ?? []) {
        seen++;
        const m = mapKapsoMessage(raw, key);
        if (SINCE && m.ts && m.ts < SINCE) { stop = true; continue; }
        tot.messages++;
        if (m.mediaId || MEDIA.includes(m.type)) { tot.media++; if (m.mediaSize) tot.mediaBytes += m.mediaSize; else tot.mediaUnknownSize++; }
        if (!db) continue;
        if (upsertMessage(db, { key }, m)) {
          tot.inserted++;
          if (CUTOVER && m.direction === 'inbound' && m.type !== 'reaction' && m.type !== 'system') markOffShift(db, m.conversationId, m.ts, true);
        }
        if (!NO_MEDIA && m.mediaId) {
          const have = db.prepare('SELECT media_path FROM messages WHERE wa_message_id=?').get(m.waMessageId) as { media_path: string | null } | undefined;
          if (have?.media_path) continue;
          try {
            const meta: Any = await withRetry(() => kapso.media.get({ mediaId: m.mediaId!, phoneNumberId: PNID }));
            const url = str(meta.downloadUrl);
            if (!url || !/^https:\/\/([a-z0-9-]+\.)*(kapso\.ai|r2\.cloudflarestorage\.com|fbsbx\.com|whatsapp\.net)\//i.test(url)) throw new Error('no url');
            const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
            if (!res.ok) throw new Error(`status ${res.status}`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            const mime = m.mediaMime ?? res.headers.get('content-type');
            setMediaFile(db, m.waMessageId, storeBytes(mediaDir(), bytes, mime), mime, bytes.byteLength);
            tot.downloaded++;
          } catch { tot.mediaFailed++; }
        }
      }
      mAfter = stop ? null : nextCursor(mp.paging);
    } while (mAfter);
    if (!SINCE && seen < expected) tot.mismatches.push({ id: String(c.id), kapso: expected, seen });
  }
  after = nextCursor(page.paging);
  if (tot.conversations % 100 === 0) console.log(`.. conversations=${tot.conversations} messages=${tot.messages} calls=${calls}`);
  await sleep(500);
} while (after);

const summary = {
  mode: DRY ? (DEEP ? 'dry-run-deep' : 'dry-run') : SINCE ? 'delta' : 'full',
  conversations: tot.conversations, contacts: tot.contacts.size, kapsoMessagesCount: tot.kapsoMessagesCount,
  messagesSeen: DEEP ? tot.messages : null, inserted: db ? tot.inserted : null,
  mediaCount: DEEP ? tot.media : null, mediaBytesKnown: DEEP ? tot.mediaBytes : null, mediaMB: DEEP ? +(tot.mediaBytes / 1048576).toFixed(1) : null, mediaUnknownSize: DEEP ? tot.mediaUnknownSize : null,
  downloaded: tot.downloaded, mediaFailed: tot.mediaFailed,
  phoneFormat: { plus: tot.phonePlus, digits: tot.phoneDigits, usernameOnly: tot.usernameOnly, idOnly: tot.idOnly },
  countMismatches: tot.mismatches.length, mismatchIds: tot.mismatches.slice(0, 50),
  kapsoCalls: calls, seconds: Math.round((Date.now() - t0) / 1000),
};
console.log(JSON.stringify(summary, null, 2));
if (db) fs.writeFileSync(path.join(path.resolve(process.env.DATA_DIR || './data'), `export-report-${Date.now()}.json`), JSON.stringify(summary, null, 2), { mode: 0o600 });
