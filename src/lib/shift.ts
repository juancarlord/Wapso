// Out-of-shift hours, auto-reply throttle and "Fuera de turno" queue (P-009-KC KC1). Pure: no '@/' imports, testable with node --test.
import type { DatabaseSync } from 'node:sqlite';

export type ShiftSettings = {
  enabled: boolean;
  timezone: string;        // IANA, e.g. America/Bogota
  open: string;            // HH:MM local
  close: string;           // HH:MM local (exclusive: 17:00:00 is closed)
  days: number[];          // 0=Sun … 6=Sat. AC-KC1-1 lock: Mon–Sat (Sat closes early, see dayClose)
  dayClose: Record<string, string>; // per-weekday close override, e.g. { '6': '12:00' } (Sat 07:00–12:00)
  lang: 'es' | 'en';       // which text is sent
  afterHoursText: { es: string; en: string };
};

// Edna PASS WITH NOTES (KC1 copy lock). Admin can edit later.
export const DEFAULT_TEXT_ES = 'Hola 👋 Gracias por escribir a Mundo Radiológico. Nuestro horario de atención es de lunes a viernes de 7:00 a. m. a 5:00 p. m. y sábados de 7:00 a. m. a 12:00 m. (hora de Colombia). Tu mensaje quedó registrado; te responderemos en el próximo horario de atención. Este canal no entrega resultados de estudios. Si es una urgencia, acude al servicio de urgencias más cercano.';
export const DEFAULT_TEXT_EN = 'Hi 👋 Thanks for messaging Mundo Radiológico. Our office hours are Monday to Friday, 7:00 a.m. to 5:00 p.m., and Saturday, 7:00 a.m. to 12:00 p.m. (Colombia time). Your message was received; we’ll reply during our next business hours. This channel does not deliver exam results. If this is an emergency, please go to the nearest emergency room.';

export const DEFAULT_SHIFT: ShiftSettings = {
  enabled: true, timezone: 'America/Bogota', open: '07:00', close: '17:00', days: [1, 2, 3, 4, 5, 6], dayClose: { '6': '12:00' }, lang: 'es',
  afterHoursText: { es: DEFAULT_TEXT_ES, en: DEFAULT_TEXT_EN },
};

/** Inbound older than this (cutover gap, delayed Meta retries) is queued but never auto-replied. */
export const STALE_MS = 10 * 60_000;
/** Types that never trigger an auto-reply (and never enter the queue). */
const NO_REPLY_TYPES = new Set(['reaction', 'system', 'unsupported', 'unknown', 'request_welcome', 'ephemeral', 'revoked']);
const KV_KEY = 'shift_settings';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_TEXT = 1000;

const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

function validTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Validate an admin update. Returns the full merged settings or a Spanish error. */
export function validateShift(input: unknown, base: ShiftSettings = DEFAULT_SHIFT): { ok: true; value: ShiftSettings } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Datos inválidos' };
  const i = input as Record<string, unknown>;
  const v: ShiftSettings = { ...base, afterHoursText: { ...base.afterHoursText }, days: [...base.days], dayClose: { ...(base.dayClose ?? {}) } };
  if ('enabled' in i) { if (typeof i.enabled !== 'boolean') return { ok: false, error: 'enabled inválido' }; v.enabled = i.enabled; }
  if ('timezone' in i) { if (!validTz(i.timezone)) return { ok: false, error: 'Zona horaria inválida' }; v.timezone = i.timezone; }
  for (const k of ['open', 'close'] as const) if (k in i) {
    if (typeof i[k] !== 'string' || !HHMM.test(i[k] as string)) return { ok: false, error: 'Hora inválida (HH:MM)' };
    v[k] = i[k] as string;
  }
  if (toMin(v.open) >= toMin(v.close)) return { ok: false, error: 'La apertura debe ser antes del cierre' };
  if ('dayClose' in i) {
    const dc = i.dayClose as Record<string, unknown> | null;
    if (!dc || typeof dc !== 'object' || Array.isArray(dc)) return { ok: false, error: 'Cierre por día inválido' };
    const out: Record<string, string> = {};
    for (const [k, t] of Object.entries(dc)) {
      if (!/^[0-6]$/.test(k) || typeof t !== 'string' || !HHMM.test(t)) return { ok: false, error: 'Cierre por día inválido' };
      out[k] = t;
    }
    v.dayClose = out;
  }
  for (const t of Object.values(v.dayClose)) if (toMin(v.open) >= toMin(t)) return { ok: false, error: 'La apertura debe ser antes del cierre' };
  if ('days' in i) {
    if (!Array.isArray(i.days) || i.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return { ok: false, error: 'Días inválidos' };
    v.days = [...new Set(i.days as number[])].sort();
  }
  if ('lang' in i) { if (i.lang !== 'es' && i.lang !== 'en') return { ok: false, error: 'Idioma inválido' }; v.lang = i.lang; }
  if ('afterHoursText' in i) {
    const t = i.afterHoursText as Record<string, unknown> | null;
    if (!t || typeof t !== 'object') return { ok: false, error: 'Texto inválido' };
    for (const l of ['es', 'en'] as const) if (l in t) {
      if (typeof t[l] !== 'string' || (t[l] as string).length > MAX_TEXT) return { ok: false, error: `Texto (${l}) inválido o muy largo` };
      v.afterHoursText[l] = (t[l] as string).trim();
    }
  }
  if (!v.afterHoursText[v.lang]) return { ok: false, error: 'El texto del idioma elegido no puede estar vacío' };
  return { ok: true, value: v };
}

export function getShift(db: DatabaseSync): ShiftSettings {
  const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(KV_KEY) as { value: string } | undefined;
  if (!r) return DEFAULT_SHIFT;
  try { const v = validateShift(JSON.parse(r.value)); return v.ok ? v.value : DEFAULT_SHIFT; } catch { return DEFAULT_SHIFT; }
}
export function saveShift(db: DatabaseSync, s: ShiftSettings) {
  db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KV_KEY, JSON.stringify(s));
}
export function autoReplyText(s: ShiftSettings): string { return s.afterHoursText[s.lang] || s.afterHoursText.es; }

// --- time helpers (DST-safe via Intl; America/Bogota is UTC-5 all year) ---
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(ts: number, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }); fmtCache.set(tz, f); }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday);
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, dow };
}
function offsetMs(ts: number, tz: string): number {
  const p = parts(ts, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}
/** Epoch ms of a local wall-clock time in tz. */
function zoned(y: number, mo: number, d: number, minutes: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, 0, minutes);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz);
  return t;
}

/** Close time for a weekday (per-day override, else the general close). */
export function closeFor(dow: number, s: ShiftSettings): string { return s.dayClose?.[String(dow)] ?? s.close; }

export function isOpenAt(ts: number, s: ShiftSettings): boolean {
  const p = parts(ts, s.timezone);
  if (!s.days.includes(p.dow)) return false;
  const m = p.h * 60 + p.mi;
  return m >= toMin(s.open) && m < toMin(closeFor(p.dow, s));
}

/** Start of the closed period containing ts (= the most recent shift close at or before ts). Stable id for the throttle. */
export function closedPeriodStart(ts: number, s: ShiftSettings): number {
  for (let k = 0; k <= 8; k++) {
    const p = parts(ts - k * 86_400_000, s.timezone);
    if (!s.days.includes(p.dow)) continue;
    const close = zoned(p.y, p.mo, p.d, toMin(closeFor(p.dow, s)), s.timezone);
    if (close <= ts) return close;
  }
  return 0; // no shift days configured: one period forever
}

// --- schema + queue ---
export function ensureShiftSchema(db: DatabaseSync) {
  const cols = (db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('off_shift_since')) db.exec('ALTER TABLE conversations ADD COLUMN off_shift_since INTEGER');
  if (!cols.includes('off_shift_cutover')) db.exec('ALTER TABLE conversations ADD COLUMN off_shift_cutover INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS auto_replies (
    contact_key TEXT NOT NULL, period_start INTEGER NOT NULL, created_at INTEGER NOT NULL, wa_message_id TEXT, outcome TEXT,
    PRIMARY KEY (contact_key, period_start));
    CREATE INDEX IF NOT EXISTS idx_conv_off_shift ON conversations(off_shift_since);`);
}

function bump(db: DatabaseSync, convId: string) {
  db.prepare("INSERT INTO kv(key,value) VALUES('change_seq','1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();
  const seq = Number((db.prepare("SELECT value FROM kv WHERE key='change_seq'").get() as { value: string }).value);
  db.prepare('UPDATE conversations SET updated_seq=? WHERE id=?').run(seq, convId);
}

/** Put a conversation in the "Fuera de turno" queue (keeps the oldest timestamp). */
export function markOffShift(db: DatabaseSync, convId: string, ts: number, cutover = false) {
  const r = db.prepare('UPDATE conversations SET off_shift_since = MIN(COALESCE(off_shift_since, ?), ?), off_shift_cutover = MAX(COALESCE(off_shift_cutover,0), ?) WHERE id = ?')
    .run(ts, ts, cutover ? 1 : 0, convId);
  if (Number(r.changes)) bump(db, convId);
}
/** Leave the queue: an agent replied or took the chat. */
export function clearOffShift(db: DatabaseSync, key: string) {
  const rows = db.prepare('SELECT id FROM conversations WHERE (id = ? OR contact_key = ?) AND off_shift_since IS NOT NULL').all(key, key) as { id: string }[];
  for (const r of rows) {
    db.prepare('UPDATE conversations SET off_shift_since = NULL, off_shift_cutover = NULL WHERE id = ?').run(r.id);
    bump(db, r.id);
  }
}

export type InboundForShift = { conversationId: string; contactKey: string; type: string; direction: string; ts: number; source: string };
export type AutoReplyJob = { contactKey: string; conversationId: string; periodStart: number; text: string };

/** Called once per NEWLY stored webhook message (replays never get here). Flags the queue and claims at most
 *  one auto-reply per contact per closed period. The claim row is written before the async send, so a Meta
 *  retry or a parallel delivery can never cause a second reply. */
export function handleInbound(db: DatabaseSync, m: InboundForShift, s: ShiftSettings, now = Date.now()): AutoReplyJob | null {
  if (m.direction !== 'inbound' || NO_REPLY_TYPES.has(m.type)) return null;
  const open = isOpenAt(m.ts, s);
  const stale = now - m.ts > STALE_MS;
  if (!open) markOffShift(db, m.conversationId, m.ts, stale);
  else if (stale && !isOpenAt(now, s)) markOffShift(db, m.conversationId, m.ts, true);
  if (open || stale || !s.enabled || m.source !== 'webhook' || isOpenAt(now, s)) return null;
  const periodStart = closedPeriodStart(m.ts, s);
  const r = db.prepare('INSERT INTO auto_replies(contact_key, period_start, created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(m.contactKey, periodStart, now);
  if (Number(r.changes) === 0) return null;
  return { contactKey: m.contactKey, conversationId: m.conversationId, periodStart, text: autoReplyText(s) };
}

export function recordAutoReplyOutcome(db: DatabaseSync, job: AutoReplyJob, outcome: 'sent' | 'failed', waMessageId?: string) {
  db.prepare('UPDATE auto_replies SET outcome = ?, wa_message_id = ? WHERE contact_key = ? AND period_start = ?').run(outcome, waMessageId ?? null, job.contactKey, job.periodStart);
}
