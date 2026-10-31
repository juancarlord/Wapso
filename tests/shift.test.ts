// P-009-KC KC1: out-of-shift auto-reply + "Fuera de turno" queue (AC-K6, AC-K7, AC-K9, AC-K10, AC-K13 validation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureInboxSchema, upsertMessage } from '../src/lib/inbox-store.ts';
import { parseWebhook } from '../src/lib/meta-webhook.ts';
import { DEFAULT_SHIFT, DEFAULT_TEXT_ES, STALE_MS, closedPeriodStart, clearOffShift, ensureShiftSchema, getShift, handleInbound, isOpenAt, saveShift, validateShift, type ShiftSettings } from '../src/lib/shift.ts';
import { listLocalConversations } from '../src/lib/inbox-read.ts';

const S = DEFAULT_SHIFT;
// COT = UTC-5. Fri 2026-10-30.
const cot = (iso: string) => Date.parse(iso + '-05:00');
const PNID = '100000000000001';
const db0 = () => { const db = new DatabaseSync(':memory:'); ensureInboxSchema(db); ensureShiftSchema(db); return db; };
let n = 0;
function inbound(db: DatabaseSync, ts: number, opts: { key?: string; type?: string; now?: number; s?: ShiftSettings; id?: string } = {}) {
  const key = opts.key ?? '573000000001';
  const id = opts.id ?? `wamid.X${++n}`;
  const m = { waMessageId: id, conversationId: key, direction: 'inbound' as const, type: opts.type ?? 'text', body: 'hola', ts, source: 'webhook' as const };
  if (!upsertMessage(db, { key, phone: key, waId: key }, m)) return { stored: false, job: null };
  return { stored: true, job: handleInbound(db, { conversationId: key, contactKey: key, type: m.type, direction: m.direction, ts, source: m.source }, opts.s ?? S, opts.now ?? ts + 1000) };
}
const off = (db: DatabaseSync, key = '573000000001') => (db.prepare('SELECT off_shift_since AS t, off_shift_cutover AS c FROM conversations WHERE id=?').get(key) as { t: number | null; c: number | null });

test('defaults (AC-KC1-1): Mon–Fri 07:00–17:00 + Sat 07:00–12:00 America/Bogota, Edna es text, enabled', () => {
  assert.deepEqual(S.days, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(S.dayClose, { '6': '12:00' });
  assert.match(S.afterHoursText.es, /sábados de 7:00 a\. m\. a 12:00 m\./);
  assert.match(S.afterHoursText.en, /Saturday, 7:00 a\.m\. to 12:00 p\.m\./);
  assert.equal(S.timezone, 'America/Bogota');
  assert.equal(S.enabled, true);
  assert.equal(S.afterHoursText.es, DEFAULT_TEXT_ES);
  assert.match(S.afterHoursText.es, /no entrega resultados/);
  assert.match(S.afterHoursText.en, /does not deliver exam results/);
});

test('shift boundaries 16:59 / 17:00 / 06:59 / 07:00 COT, Sunday closed', () => {
  assert.equal(isOpenAt(cot('2026-10-30T16:59:59'), S), true);
  assert.equal(isOpenAt(cot('2026-10-30T17:00:00'), S), false);
  assert.equal(isOpenAt(cot('2026-10-30T06:59:59'), S), false);
  assert.equal(isOpenAt(cot('2026-10-30T07:00:00'), S), true);
  assert.equal(isOpenAt(cot('2026-11-01T10:00:00'), S), false); // Sun
  assert.equal(isOpenAt(cot('2026-11-02T07:00:00'), S), true);  // Mon
});

test('AC-KC1-1 Saturday midday: Sat 07:00–11:59 open, 06:59 / 12:00+ closed; Sunday closed', () => {
  assert.equal(isOpenAt(cot('2026-10-31T06:59:59'), S), false);
  assert.equal(isOpenAt(cot('2026-10-31T07:00:00'), S), true);
  assert.equal(isOpenAt(cot('2026-10-31T10:00:00'), S), true);
  assert.equal(isOpenAt(cot('2026-10-31T11:59:59'), S), true);
  assert.equal(isOpenAt(cot('2026-10-31T12:00:00'), S), false);
  assert.equal(isOpenAt(cot('2026-10-31T15:00:00'), S), false);
  assert.equal(isOpenAt(cot('2026-11-01T00:00:00'), S), false); // Sun
  assert.equal(isOpenAt(cot('2026-11-01T10:00:00'), S), false);
  assert.equal(isOpenAt(cot('2026-11-01T23:59:59'), S), false);
});

test('AC-KC1-1 Saturday after 12:00 → one auto-reply + Fuera de turno; Sunday same period', () => {
  const db = db0();
  assert.equal(inbound(db, cot('2026-10-31T11:30:00')).job, null);
  assert.equal(off(db).t, null);
  assert.ok(inbound(db, cot('2026-10-31T12:00:00')).job);
  assert.equal(off(db).t, cot('2026-10-31T12:00:00'));
  assert.equal(inbound(db, cot('2026-11-01T10:00:00')).job, null); // Sunday = same period as Sat 12:00
});

test('validate dayClose', () => {
  assert.equal(validateShift({ dayClose: { '6': '13:00' } }).ok, true);
  assert.equal(validateShift({ dayClose: { '7': '12:00' } }).ok, false);
  assert.equal(validateShift({ dayClose: { '6': '06:00' } }).ok, false);
  assert.equal(validateShift({ dayClose: [] }).ok, false);
});

test('closed period: Fri 17:00 → Sat 07:00; Sat 12:00 → Mon 07:00 is ONE period; weekday night is its own', () => {
  const fri = cot('2026-10-30T17:00:00');
  const sat = cot('2026-10-31T12:00:00');
  assert.equal(closedPeriodStart(cot('2026-10-30T17:00:00'), S), fri);
  assert.equal(closedPeriodStart(cot('2026-10-31T06:59:00'), S), fri);
  assert.equal(closedPeriodStart(cot('2026-10-31T12:00:00'), S), sat);
  assert.equal(closedPeriodStart(cot('2026-11-01T12:00:00'), S), sat);
  assert.equal(closedPeriodStart(cot('2026-11-02T06:59:00'), S), sat);
  assert.equal(closedPeriodStart(cot('2026-11-03T05:00:00'), S), cot('2026-11-02T17:00:00'));
});

test('AC-K6: 16:59 → no reply, not queued; 17:00 → exactly one reply; second msg same period → none', () => {
  const db = db0();
  assert.equal(inbound(db, cot('2026-10-30T16:59:00')).job, null);
  assert.equal(off(db).t, null);
  const a = inbound(db, cot('2026-10-30T17:00:00'));
  assert.ok(a.job);
  assert.equal(a.job!.text, DEFAULT_TEXT_ES);
  assert.equal(inbound(db, cot('2026-10-30T20:00:00')).job, null);
  assert.equal(inbound(db, cot('2026-10-31T06:30:00')).job, null); // Sat before 07:00 = same closed period
  assert.equal(inbound(db, cot('2026-10-31T09:00:00')).job, null); // Sat 09:00 = open (AC-KC1-1)
  assert.ok(inbound(db, cot('2026-10-30T21:00:00'), { key: '573000000002' }).job); // other contact gets their own
  // Next closed period (Mon night) → a new reply
  assert.ok(inbound(db, cot('2026-11-02T18:00:00')).job);
});

test('before 07:00 COT counts as closed (reply once)', () => {
  const db = db0();
  assert.ok(inbound(db, cot('2026-11-03T06:30:00')).job);
  assert.equal(inbound(db, cot('2026-11-03T06:45:00')).job, null);
});

test('AC-K7: idempotent on Meta retry (same wamid) → no second reply', () => {
  const db = db0();
  const ts = cot('2026-10-30T18:00:00');
  assert.ok(inbound(db, ts, { id: 'wamid.R1' }).job);
  const again = inbound(db, ts, { id: 'wamid.R1' });
  assert.equal(again.stored, false);
  assert.equal(again.job, null);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM auto_replies').get() as { c: number }).c, 1);
});

test('AC-K7: reactions, system events, unsupported → no reply and no queue', () => {
  const db = db0();
  for (const type of ['reaction', 'system', 'unsupported']) assert.equal(inbound(db, cot('2026-10-30T19:00:00'), { type }).job, null);
  assert.equal(off(db).t, null);
});

test('AC-K7: statuses, echoes, own number and other phone_number_ids never become inbound', () => {
  const base = (value: Record<string, unknown>) => ({ entry: [{ changes: [{ field: 'messages', value: { metadata: { display_phone_number: '573000000000', phone_number_id: PNID }, ...value } }] }] });
  assert.equal(parseWebhook(base({ statuses: [{ id: 'wamid.S', status: 'delivered', timestamp: '1', recipient_id: '573000000001' }] }), PNID).inbound.length, 0);
  assert.equal(parseWebhook({ entry: [{ changes: [{ field: 'smb_message_echoes', value: { metadata: { phone_number_id: PNID }, message_echoes: [{ id: 'wamid.E', from: '573000000000', type: 'text', text: { body: 'x' } }] } }] }] }, PNID).inbound.length, 0);
  assert.equal(parseWebhook(base({ messages: [{ id: 'wamid.O', from: '573000000000', timestamp: '1', type: 'text', text: { body: 'x' } }] }), PNID).inbound.length, 0);
  assert.equal(parseWebhook(base({ messages: [{ id: 'wamid.P', from: '573000000001', timestamp: '1', type: 'text', text: { body: 'x' } }] }), '999').inbound.length, 0);
});

test('outbound / non-webhook sources never auto-reply', () => {
  const db = db0();
  const ts = cot('2026-10-30T19:00:00');
  assert.equal(handleInbound(db, { conversationId: 'k', contactKey: 'k', type: 'text', direction: 'outbound', ts, source: 'send' }, S, ts), null);
  upsertMessage(db, { key: 'k' }, { waMessageId: 'wamid.K', conversationId: 'k', direction: 'inbound', type: 'text', ts, source: 'kapso_export' });
  assert.equal(handleInbound(db, { conversationId: 'k', contactKey: 'k', type: 'text', direction: 'inbound', ts, source: 'kapso_export' }, S, ts), null);
  assert.ok(off(db, 'k').t); // still queued
});

test('toggle off (AC-K13): queued but no reply', () => {
  const db = db0();
  assert.equal(inbound(db, cot('2026-10-30T19:00:00'), { s: { ...S, enabled: false } }).job, null);
  assert.ok(off(db).t);
});

test('AC-K10: stale (>10 min) cutover-gap message → queued with cutover flag, no reply', () => {
  const db = db0();
  const ts = cot('2026-10-31T18:00:00');
  assert.equal(inbound(db, ts, { now: ts + STALE_MS + 1 }).job, null);
  assert.deepEqual({ ...off(db) }, { t: ts, c: 1 });
  assert.ok(inbound(db, ts + 1000, { key: '573000000009', now: ts + STALE_MS - 1000 }).job); // fresh enough → reply
});

test('AC-K9: queue keeps oldest, lists via inbox-read, clears on reply/Tomar', () => {
  const db = db0();
  const t1 = cot('2026-10-30T18:00:00');
  inbound(db, t1); inbound(db, t1 + 3600_000);
  assert.equal(off(db).t, t1);
  const row = listLocalConversations(db, PNID).find((c) => c.id === '573000000001')!;
  assert.equal(row.offShiftSince, new Date(t1).toISOString());
  clearOffShift(db, '573000000001');
  assert.equal(off(db).t, null);
  assert.equal(listLocalConversations(db, PNID)[0].offShiftSince, null);
  inbound(db, cot('2026-10-30T23:00:00')); // writes again while closed → back in the queue (no 2nd reply)
  assert.ok(off(db).t);
});

test('settings kv: defaults, save/load, validation', () => {
  const db = db0();
  assert.deepEqual(getShift(db), S);
  const v = validateShift({ open: '08:00', close: '16:00', enabled: false, afterHoursText: { en: 'Closed' }, lang: 'en' }, S);
  assert.ok(v.ok);
  if (v.ok) { saveShift(db, v.value); assert.equal(getShift(db).open, '08:00'); assert.equal(getShift(db).afterHoursText.es, DEFAULT_TEXT_ES); }
  assert.equal(validateShift({ open: '18:00', close: '17:00' }).ok, false);
  assert.equal(validateShift({ open: '7am' }).ok, false);
  assert.equal(validateShift({ timezone: 'Mars/Base' }).ok, false);
  assert.equal(validateShift({ days: [7] }).ok, false);
  assert.equal(validateShift({ afterHoursText: { es: 'x'.repeat(1001) } }).ok, false);
  assert.equal(validateShift([]).ok, false);
});
