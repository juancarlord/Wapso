import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureInboxSchema, upsertMessage, setMediaFile } from '../src/lib/inbox-store.ts';
import { storeBytes } from '../src/lib/media-store.ts';
import { bucketConfig, objectKeyFor, signV4 } from '../src/lib/bucket.ts';
import { hotDays, selectTierCandidates, tierMedia } from '../src/lib/media-tier.ts';
import { openMediaSource } from '../src/lib/media-source.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12);
const cfg = bucketConfig({ MEDIA_BUCKET_URL: 'https://storage.googleapis.com/test-media', MEDIA_BUCKET_ACCESS_KEY_ID: 'GOOGTEST', MEDIA_BUCKET_SECRET_ACCESS_KEY: 'not-a-real-secret' })!;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-'));
  const db = new DatabaseSync(':memory:'); ensureInboxSchema(db);
  const add = (id: string, ageDays: number, bytes: Uint8Array, mime = 'image/jpeg') => {
    upsertMessage(db, { key: '573000000001', phone: '573000000001' }, { waMessageId: id, conversationId: '573000000001', direction: 'inbound', type: 'image', ts: NOW - ageDays * DAY, source: 'webhook', mediaMime: mime });
    const rel = storeBytes(dir, bytes, mime);
    setMediaFile(db, id, rel, mime, bytes.byteLength);
    return rel;
  };
  return { dir, db, add };
}

/** In-memory S3-ish bucket. corrupt=true makes HEAD report a wrong ETag (simulates a bad upload). */
function mockBucket(opts: { corrupt?: boolean; failPut?: boolean } = {}) {
  const store = new Map<string, Buffer>();
  const calls: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url)); const key = u.pathname.replace(/^\/test-media\//, '');
    const m = init?.method ?? 'GET'; calls.push(`${m} ${key}`);
    const h = new Headers(init?.headers);
    assert.match(h.get('authorization') ?? '', /^AWS4-HMAC-SHA256 Credential=GOOGTEST\//);
    if (m === 'PUT') {
      if (opts.failPut) return new Response('no', { status: 500 });
      const body = Buffer.from(init!.body as Uint8Array);
      if (crypto.createHash('md5').update(body).digest('base64') !== h.get('content-md5')) return new Response('BadDigest', { status: 400 });
      store.set(key, body); return new Response(null, { status: 200 });
    }
    const b = store.get(key);
    if (!b) return new Response(null, { status: 404 });
    const etag = opts.corrupt ? 'deadbeef' : crypto.createHash('md5').update(b).digest('hex');
    if (m === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(b.byteLength), etag: `"${etag}"` } });
    return new Response(new Uint8Array(b) as unknown as BodyInit, { status: 200, headers: { 'content-length': String(b.byteLength) } });
  }) as typeof fetch;
  return { f, store, calls };
}

test('config: disabled without bucket vars; hot days default 7', () => {
  assert.equal(bucketConfig({}), null);
  assert.equal(bucketConfig({ MEDIA_BUCKET_URL: 'http://x', MEDIA_BUCKET_ACCESS_KEY_ID: 'a', MEDIA_BUCKET_SECRET_ACCESS_KEY: 'b' }), null);
  assert.equal(cfg.region, 'auto');
  assert.equal(hotDays({}), 7); assert.equal(hotDays({ MEDIA_HOT_DAYS: '14' }), 14); assert.equal(hotDays({ MEDIA_HOT_DAYS: 'x' }), 7);
  const s = signV4(cfg, 'GET', 'media/ab/x.jpg', {}, new Date(NOW));
  assert.match(s.headers.Authorization, /Credential=GOOGTEST\/20261020\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
  assert.equal(s.headers['x-amz-date'], '20261020T120000Z');
});

test('older-than selection: only files whose newest message is past the cutoff', () => {
  const { db, add } = setup();
  const old = add('wamid.old', 10, Buffer.from('old-bytes'));
  add('wamid.new', 2, Buffer.from('new-bytes'));
  // Same file referenced by an old and a recent message (dedupe): stays hot.
  add('wamid.sharedOld', 20, Buffer.from('shared'));
  add('wamid.sharedNew', 1, Buffer.from('shared'));
  assert.deepEqual(selectTierCandidates(db, NOW - 7 * DAY).map((r) => r.rel), [old]);
});

test('move: upload, verify, record, then delete; re-run is a no-op', async () => {
  const { dir, db, add } = setup();
  const rel = add('wamid.old', 10, Buffer.from('radiografia'));
  const b = mockBucket();
  const r = await tierMedia({ db, dir, cfg, now: NOW, days: 7, fetchImpl: b.f });
  assert.deepEqual({ moved: r.moved, failed: r.failed }, { moved: 1, failed: 0 });
  assert.equal(fs.existsSync(path.join(dir, rel)), false);
  assert.deepEqual(b.store.get(objectKeyFor(rel)), Buffer.from('radiografia'));
  const row = db.prepare("SELECT media_storage AS s, media_object_key AS k FROM messages WHERE wa_message_id='wamid.old'").get() as Record<string, string>;
  assert.deepEqual({ ...row }, { s: 'bucket', k: objectKeyFor(rel) });
  const again = await tierMedia({ db, dir, cfg, now: NOW, days: 7, fetchImpl: b.f });
  assert.deepEqual({ moved: again.moved, skipped: again.skipped, failed: again.failed }, { moved: 0, skipped: 1, failed: 0 });
});

test('delete only after verified: bad ETag or failed PUT keeps the local file and DB untouched', async () => {
  for (const opts of [{ corrupt: true }, { failPut: true }]) {
    const { dir, db, add } = setup();
    const rel = add('wamid.old', 10, Buffer.from('keep-me'));
    const r = await tierMedia({ db, dir, cfg, now: NOW, days: 7, fetchImpl: mockBucket(opts).f });
    assert.equal(r.failed, 1);
    assert.equal(fs.existsSync(path.join(dir, rel)), true);
    const row = db.prepare("SELECT media_storage AS s FROM messages WHERE wa_message_id='wamid.old'").get() as { s: string | null };
    assert.equal(row.s, null);
  }
});

test('resume: object already uploaded (crash before delete) is verified and cleaned, no second PUT', async () => {
  const { dir, db, add } = setup();
  const rel = add('wamid.old', 10, Buffer.from('half-done'));
  const b = mockBucket();
  b.store.set(objectKeyFor(rel), Buffer.from('half-done'));
  const r = await tierMedia({ db, dir, cfg, now: NOW, days: 7, fetchImpl: b.f });
  assert.equal(r.cleaned, 1);
  assert.equal(b.calls.filter((c) => c.startsWith('PUT')).length, 0);
  assert.equal(fs.existsSync(path.join(dir, rel)), false);
});

test('serve fallback: local first, then bucket (server-side), else null', async () => {
  const { dir, add } = setup();
  const rel = add('wamid.a', 10, Buffer.from('local-copy'));
  const b = mockBucket();
  const key = objectKeyFor(rel);
  b.store.set(key, Buffer.from('bucket-copy'));
  const local = await openMediaSource({ dir, rel, objectKey: key, cfg, fetchImpl: b.f });
  assert.equal(local?.from, 'local');
  assert.equal(await new Response(local!.body).text(), 'local-copy');
  assert.equal(b.calls.length, 0);
  fs.unlinkSync(path.join(dir, rel));
  const remote = await openMediaSource({ dir, rel, objectKey: key, cfg, fetchImpl: b.f });
  assert.equal(remote?.from, 'bucket');
  assert.equal(await new Response(remote!.body).text(), 'bucket-copy');
  assert.equal(await openMediaSource({ dir, rel, objectKey: key, cfg: null, fetchImpl: b.f }), null); // tiering disabled
  assert.equal(await openMediaSource({ dir, rel, objectKey: '../etc/passwd', cfg, fetchImpl: b.f }), null); // bad key
  b.store.clear();
  assert.equal(await openMediaSource({ dir, rel, objectKey: key, cfg, fetchImpl: b.f }), null); // missing object
});
