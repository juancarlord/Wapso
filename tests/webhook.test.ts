import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { verifySignature, verifyChallenge, parseWebhook } from '../src/lib/meta-webhook.ts';
import { ensureInboxSchema, upsertMessage, applyStatus, seenEvent, migrateLegacyKeys, getSeq, resolveContact } from '../src/lib/inbox-store.ts';
import { planOutboundMedia, friendlySendError, graphErrorCode, isBsuid, shouldSendTyping, readReceiptInput, TYPING_INTERVAL_MS } from '../src/lib/send-rules.ts';
import { contactKey } from '../src/lib/contact-key.ts';
import { graphVersion } from '../src/lib/config.ts';

const SECRET = 'test-app-secret';
const PNID = '100000000000001';
const sign = (raw: string, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
const payload = (over: Record<string, unknown> = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '573000000000', phone_number_id: PNID },
    contacts: [{ wa_id: '573000000001', profile: { name: 'TEST^Paciente' } }],
    messages: [
      { id: 'wamid.T1', from: '573000000001', timestamp: '1760900000', type: 'text', text: { body: 'hola' } },
      { id: 'wamid.I1', from: '573000000001', timestamp: '1760900010', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'foto' } },
    ],
    ...over,
  } }] }],
});
const freshDb = () => { const db = new DatabaseSync(':memory:'); ensureInboxSchema(db); return db; };

test('signature: valid, tampered, wrong secret, missing', () => {
  const raw = JSON.stringify(payload());
  assert.equal(verifySignature(raw, sign(raw), SECRET), true);
  assert.equal(verifySignature(raw + ' ', sign(raw), SECRET), false);
  assert.equal(verifySignature(raw, sign(raw, 'other'), SECRET), false);
  assert.equal(verifySignature(raw, null, SECRET), false);
  assert.equal(verifySignature(raw, 'sha256=abc', SECRET), false);
  assert.equal(verifySignature(raw, sign(raw), undefined), false);
});

test('GET verify challenge', () => {
  const tok = 'x'.repeat(40);
  const ok = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': tok, 'hub.challenge': '123' });
  assert.equal(verifyChallenge(ok, tok), '123');
  assert.equal(verifyChallenge(new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'bad', 'hub.challenge': '1' }), tok), null);
  assert.equal(verifyChallenge(ok, undefined), null);
});

test('parse: our number kept, other number ignored', () => {
  const p = parseWebhook(payload(), PNID);
  assert.equal(p.inbound.length, 2);
  assert.equal(p.inbound[0].message.conversationId, '573000000001');
  assert.equal(p.inbound[1].message.mediaId, 'MEDIA1');
  assert.equal(parseWebhook(payload(), '999').inbound.length, 0);
});

test('username-only contact: new key is the BSUID, never @username when a BSUID exists', () => {
  const p = parseWebhook(payload({ contacts: [{ user_id: 'CO.123', profile: { name: 'X', username: 'xiomy' } }],
    messages: [{ id: 'wamid.U1', from_user_id: 'CO.123', timestamp: '1760900000', type: 'text', text: { body: 'hi' } }] }), PNID);
  assert.equal(p.inbound[0].contact.key, 'CO.123');
  assert.equal(p.inbound[0].contact.bsuid, 'CO.123');
});

test('idempotent insert: replay keeps one row, count and seq unchanged', () => {
  const db = freshDb();
  const run = () => parseWebhook(payload(), PNID).inbound.filter((x) => upsertMessage(db, x.contact, x.message, x.raw)).length;
  assert.equal(run(), 2);
  const seq = getSeq(db);
  assert.equal(run(), 0);
  assert.equal(getSeq(db), seq);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c, 2);
  const conv = db.prepare('SELECT messages_count n, last_message_preview p FROM conversations').get() as { n: number; p: string };
  assert.equal(conv.n, 2);
  assert.equal(conv.p, 'foto');
});

test('statuses only move forward; failed terminal', () => {
  const db = freshDb();
  upsertMessage(db, { key: '573000000001' }, { waMessageId: 'wamid.O1', conversationId: '573000000001', direction: 'outbound', type: 'text', body: 'x', ts: 1, source: 'send' });
  applyStatus(db, 'wamid.O1', 'read', 3);
  applyStatus(db, 'wamid.O1', 'delivered', 2);
  assert.equal((db.prepare("SELECT status s FROM messages").get() as { s: string }).s, 'read');
  applyStatus(db, 'wamid.O1', 'failed', 4, 131047);
  applyStatus(db, 'wamid.O1', 'read', 5);
  assert.equal((db.prepare("SELECT status s FROM messages").get() as { s: string }).s, 'failed');
});

test('meta_events dedupe', () => {
  const db = freshDb();
  assert.equal(seenEvent(db, 'e1'), false);
  assert.equal(seenEvent(db, 'e1'), true);
});

test('legacy rekey moves reads/assignments to our ids, idempotent', () => {
  const db = freshDb();
  db.exec(`CREATE TABLE conversation_reads (user_id INTEGER, conversation_id TEXT, last_read_at INTEGER, PRIMARY KEY(user_id, conversation_id));
           CREATE TABLE conversation_assignments (contact_key TEXT PRIMARY KEY, updated_at INTEGER);
           INSERT INTO conversation_reads VALUES (1,'kapso-1',5); INSERT INTO conversation_assignments VALUES ('kapso-1',1);`);
  upsertMessage(db, { key: '@u', username: 'u', legacyKapsoId: 'kapso-1' }, { waMessageId: 'w', conversationId: '@u', direction: 'inbound', type: 'text', ts: 1, source: 'kapso_export' });
  assert.deepEqual(migrateLegacyKeys(db), { reads: 1, assignments: 1 });
  assert.deepEqual(migrateLegacyKeys(db), { reads: 0, assignments: 0 });
});

// --- Meta alignment fixes (2026-10-19) ---
const ingest = (db: DatabaseSync, body: unknown) => parseWebhook(body, PNID).inbound.map((p) => {
  const c = resolveContact(db, p.contact, p.change);
  p.message.conversationId = c.key;
  upsertMessage(db, c, p.message, p.raw);
  return c.key;
});
const msgPayload = (contacts: unknown[], messages: unknown[]) => payload({ contacts, messages });

test('contact match: BSUID first, keys stay stable when the phone disappears', () => {
  const db = freshDb();
  const k1 = ingest(db, msgPayload([{ wa_id: '573000000001', user_id: 'CO.777', profile: { name: 'A' } }],
    [{ id: 'wamid.B1', from: '573000000001', from_user_id: 'CO.777', timestamp: '1760900000', type: 'text', text: { body: 'a' } }]));
  assert.deepEqual(k1, ['573000000001']);
  // 30+ days later: no phone, now has a username. Must land in the same chat, not '@ana' or 'CO.777'.
  const k2 = ingest(db, msgPayload([{ wa_id: '', user_id: 'CO.777', profile: { name: 'A', username: 'ana' } }],
    [{ id: 'wamid.B2', from_user_id: 'CO.777', timestamp: '1760990000', type: 'text', text: { body: 'b' } }]));
  assert.deepEqual(k2, ['573000000001']);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT bsuid FROM contacts WHERE key='573000000001'").get() as { bsuid: string }).bsuid, 'CO.777');
});

test('contact match: phone when no BSUID row yet; legacy @username keys from the Kapso export stay', () => {
  const db = freshDb();
  upsertMessage(db, { key: '573000000009', phone: '573000000009', waId: '573000000009' }, { waMessageId: 'x1', conversationId: '573000000009', direction: 'inbound', type: 'text', ts: 1, source: 'kapso_export' });
  upsertMessage(db, { key: '@xiomy', username: 'xiomy' }, { waMessageId: 'x2', conversationId: '@xiomy', direction: 'inbound', type: 'text', ts: 1, source: 'kapso_export' });
  assert.deepEqual(ingest(db, msgPayload([{ wa_id: '573000000009', user_id: 'CO.9' }],
    [{ id: 'wamid.P1', from: '573000000009', timestamp: '1760900000', type: 'text', text: { body: 'p' } }])), ['573000000009']);
  assert.deepEqual(ingest(db, msgPayload([{ user_id: 'CO.55', profile: { username: 'xiomy' } }],
    [{ id: 'wamid.X1', from_user_id: 'CO.55', timestamp: '1760900000', type: 'text', text: { body: 'x' } }])), ['@xiomy']);
  // Next time the BSUID alone finds it.
  assert.deepEqual(ingest(db, msgPayload([{ user_id: 'CO.55' }],
    [{ id: 'wamid.X2', from_user_id: 'CO.55', timestamp: '1760900100', type: 'text', text: { body: 'y' } }])), ['@xiomy']);
});

test('system: number change and BSUID change link to the existing contact', () => {
  const db = freshDb();
  ingest(db, msgPayload([{ wa_id: '573000000001', user_id: 'CO.1' }],
    [{ id: 'wamid.S0', from: '573000000001', from_user_id: 'CO.1', timestamp: '1760900000', type: 'text', text: { body: 'hola' } }]));
  const keys = ingest(db, msgPayload([{ wa_id: '573000000001', user_id: 'CO.1' }],
    [{ id: 'wamid.S1', from: '573000000001', timestamp: '1760900100', type: 'system',
       system: { body: 'User A changed from 573000000001 to 573000000002', wa_id: '573000000002', user_id: 'CO.2', type: 'user_changed_number' } }]));
  assert.deepEqual(keys, ['573000000001']);
  const c = db.prepare("SELECT phone, wa_id, bsuid FROM contacts WHERE key='573000000001'").get() as Record<string, string>;
  assert.deepEqual({ ...c }, { phone: '573000000002', wa_id: '573000000002', bsuid: 'CO.2' });
  // A message from the new number lands in the same chat.
  assert.deepEqual(ingest(db, msgPayload([{ wa_id: '573000000002', user_id: 'CO.2' }],
    [{ id: 'wamid.S2', from: '573000000002', timestamp: '1760900200', type: 'text', text: { body: 'nuevo' } }])), ['573000000001']);
  // BSUID change (previous_user_id).
  assert.deepEqual(ingest(db, msgPayload([],
    [{ id: 'wamid.S3', from_user_id: 'CO.2', timestamp: '1760900300', type: 'system',
       system: { body: 'User changed from CO.2 to CO.3', user_id: 'CO.3', previous_user_id: 'CO.2', type: 'user_changed_user_id' } }])), ['573000000001']);
  assert.equal((db.prepare("SELECT bsuid FROM contacts WHERE key='573000000001'").get() as { bsuid: string }).bsuid, 'CO.3');
  assert.equal((db.prepare("SELECT body FROM messages WHERE wa_message_id='wamid.S1'").get() as { body: string }).body, 'User A changed from 573000000001 to 573000000002');
});

test('errors: unsupported message stores errors[0] code/title; value.errors are collected', () => {
  const db = freshDb();
  const body = payload({ errors: [{ code: 131051, title: 'Message type unknown' }], messages: [
    { id: 'wamid.E1', from: '573000000001', timestamp: '1760900000', type: 'unsupported', errors: [{ code: 131051, title: 'Message type unknown' }] }] });
  const p = parseWebhook(body, PNID);
  assert.deepEqual(p.errors, [{ code: 131051, title: 'Message type unknown' }]);
  assert.equal(p.inbound[0].message.errorCode, 131051);
  ingest(db, body);
  const r = db.prepare("SELECT error_code, error_title FROM messages WHERE wa_message_id='wamid.E1'").get() as Record<string, unknown>;
  assert.deepEqual({ ...r }, { error_code: 131051, error_title: 'Message type unknown' });
});

test('signature: verified on the raw Buffer, including non-ASCII bytes', () => {
  const raw = Buffer.from(JSON.stringify(payload({ messages: [{ id: 'wamid.N1', from: '573000000001', timestamp: '1', type: 'text', text: { body: 'Radiología ñ 📷' } }] })), 'utf8');
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  assert.equal(verifySignature(raw, sig, SECRET), true);
  const tampered = Buffer.from(raw); tampered[tampered.length - 2] ^= 1;
  assert.equal(verifySignature(tampered, sig, SECRET), false);
});

test('outbound media: allowlist and size limits', () => {
  const MB = 1024 * 1024;
  assert.deepEqual(planOutboundMedia('image/jpeg', 1 * MB), { ok: true, type: 'image' });
  assert.deepEqual(planOutboundMedia('image/png', 4 * MB), { ok: true, type: 'image' });
  assert.equal(planOutboundMedia('image/jpeg', 6 * MB).ok, false);
  assert.deepEqual(planOutboundMedia('image/webp', 100_000), { ok: true, type: 'document' });
  assert.deepEqual(planOutboundMedia('image/webp', 100_000, { sticker: true }), { ok: true, type: 'sticker' });
  assert.equal(planOutboundMedia('image/webp', 600_000, { sticker: true }).ok, false);
  assert.deepEqual(planOutboundMedia('image/gif', 1000), { ok: true, type: 'document' });
  assert.deepEqual(planOutboundMedia('text/plain', 1000), { ok: true, type: 'document' });
  assert.deepEqual(planOutboundMedia('audio/ogg; codecs=opus', 1000), { ok: true, type: 'audio' });
  assert.equal(planOutboundMedia('video/mp4', 17 * MB).ok, false);
  assert.deepEqual(planOutboundMedia('application/pdf', 99 * MB), { ok: true, type: 'document' });
  assert.equal(planOutboundMedia('application/pdf', 101 * MB).ok, false);
  assert.equal(planOutboundMedia(null, 0).ok, false);
  const e = planOutboundMedia('image/jpeg', 6 * MB);
  assert.ok(!e.ok && /5 MB/.test(e.error));
});

test('send rules: BSUID detection and Graph error mapping', () => {
  assert.equal(isBsuid('CO.13491208655302741918'), true);
  assert.equal(isBsuid('+573000000001'), false);
  assert.equal(friendlySendError(130429)?.status, 429);
  assert.equal(friendlySendError(131056)?.status, 429);
  assert.equal(friendlySendError(80007)?.status, 429);
  assert.equal(friendlySendError(131026)?.status, 422);
  assert.equal(friendlySendError(131049)?.status, 422);
  assert.equal(friendlySendError(131000), null);
  assert.equal(graphErrorCode({ code: 131056 }), 131056);
  assert.equal(graphErrorCode({ error: { code: 130429 } }), 130429);
  assert.equal(graphErrorCode(new Error('(#131026) Message undeliverable')), 131026);
  assert.equal(graphErrorCode(new Error('boom 404')), null);
});

test('K1: local chat key wins for assignments; Kapso keys unchanged', () => {
  // Local, username-only contact: chat id is the BSUID, not @username.
  assert.equal(contactKey({ id: 'CO.555', chatKey: 'CO.555', username: 'ana', phoneNumber: '' }), 'CO.555');
  // Local legacy contact from the Kapso export keeps '@xiomy'.
  assert.equal(contactKey({ id: '@xiomy', chatKey: '@xiomy', username: 'xiomy' }), '@xiomy');
  // Local phone contact: same as before.
  assert.equal(contactKey({ id: '573000000001', chatKey: '573000000001', phoneNumber: '573000000001' }), '573000000001');
  // Kapso mode (no chatKey): unchanged rule.
  assert.equal(contactKey({ id: 'k1,k2', phoneNumber: '', username: 'ana' }), '@ana');
  assert.equal(contactKey({ id: 'k1,k2', phoneNumber: '573000000001', username: 'ana' }), '573000000001');
  assert.equal(contactKey({ id: 'k1,k2' }), 'k1');
  // End to end: a new username-only patient gets chat id = BSUID, and contactKey matches it.
  const db = freshDb();
  const [k] = ingest(db, msgPayload([{ user_id: 'CO.555', profile: { username: 'ana' } }],
    [{ id: 'wamid.K1', from_user_id: 'CO.555', timestamp: '1760900000', type: 'text', text: { body: 'hola' } }]));
  assert.equal(k, 'CO.555');
  assert.equal(contactKey({ id: k, chatKey: k, username: 'ana' }), 'CO.555');
});

test('K2: read receipts carry no typing indicator; typing is opt-in and throttled to ~20 s', () => {
  assert.deepEqual(readReceiptInput('PN', 'wamid.1', false), { phoneNumberId: 'PN', messageId: 'wamid.1' });
  assert.deepEqual(readReceiptInput('PN', 'wamid.1', true), { phoneNumberId: 'PN', messageId: 'wamid.1', typingIndicator: { type: 'text' } });
  assert.equal(TYPING_INTERVAL_MS, 20_000);
  assert.equal(shouldSendTyping(undefined, 1_000), true);
  assert.equal(shouldSendTyping(1_000, 5_000), false);
  assert.equal(shouldSendTyping(1_000, 20_999), false);
  assert.equal(shouldSendTyping(1_000, 21_000), true);
});

test('K4: META_GRAPH_VERSION validated, falls back to v26.0', () => {
  assert.equal(graphVersion({ META_GRAPH_VERSION: 'v25.0' }), 'v25.0');
  assert.equal(graphVersion({}), 'v26.0');
  assert.equal(graphVersion({ META_GRAPH_VERSION: '24' }), 'v26.0');
  assert.equal(graphVersion({ META_GRAPH_VERSION: 'v26.0/../x' }), 'v26.0');
});
