import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrub, safeError } from '../src/lib/log.ts';
import { shouldSend } from '../src/lib/alert.ts';
import { configProblems } from '../src/lib/config.ts';
import { resolveMediaPath, storeBytes, isMetaMediaHost } from '../src/lib/media-store.ts';

test('hasOwn period guard', () => {
  const PERIODS = { hoy: 1, '7d': 7, '30d': 30 };
  for (const p of ['__proto__', 'toString', 'constructor']) assert.equal(Object.hasOwn(PERIODS, p), false);
  assert.equal(Object.hasOwn(PERIODS, '7d'), true);
});

test('safeError strips phone numbers and tokens, never prints objects', () => {
  assert.ok(!scrub('failed for +573000000001').includes('3000000001'));
  assert.ok(!scrub('Bearer abc.def').includes('abc.def'));
  const out: string[] = []; const orig = console.error; console.error = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  try { safeError('t', Object.assign(new Error('to 573000000001'), { status: 400, headers: { Authorization: 'Bearer SECRET' } })); } finally { console.error = orig; }
  assert.equal(out.length, 1);
  assert.ok(!out[0].includes('SECRET') && !out[0].includes('573000000001') && out[0].includes('status=400'));
});

test('alert limiter: once per type per hour', () => {
  assert.equal(shouldSend('x', 0 + 1e12), true);
  assert.equal(shouldSend('x', 1e12 + 1000), false);
  assert.equal(shouldSend('x', 1e12 + 3_600_001), true);
});

test('config: each missing var reported', () => {
  const base = { AUTH_SECRET: 'a'.repeat(40), DATA_DIR: '/d', PHONE_NUMBER_ID: '1', WABA_ID: '2', APP_ORIGIN: 'https://x', ALERT_WEBHOOK_URL: 'https://a', INBOX_SOURCE: 'local',
    META_ACCESS_TOKEN: 't', META_APP_SECRET: 's', META_WEBHOOK_VERIFY_TOKEN: 'v'.repeat(32), META_GRAPH_VERSION: 'v24.0' };
  assert.deepEqual(configProblems(base), []);
  for (const k of Object.keys(base)) if (k !== 'INBOX_SOURCE') assert.ok(configProblems({ ...base, [k]: '' }).length > 0, k);
  assert.ok(configProblems({ ...base, INBOX_SOURCE: 'kapso' }).includes('KAPSO_API_KEY missing'));
});

test('media: traversal rejected, dedupe by sha256, host allowlist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wapso-media-'));
  assert.equal(resolveMediaPath(dir, '../etc/passwd'), null);
  assert.equal(resolveMediaPath(dir, 'a'.repeat(64) + '.jpg/../../x'), null);
  const a = storeBytes(dir, new Uint8Array([1, 2, 3]), 'image/jpeg');
  const b = storeBytes(dir, new Uint8Array([1, 2, 3]), 'image/jpeg');
  assert.equal(a, b);
  assert.ok(resolveMediaPath(dir, a));
  assert.equal(isMetaMediaHost('https://lookaside.fbsbx.com/x'), true);
  assert.equal(isMetaMediaHost('https://evil.com/fbsbx.com'), false);
  assert.equal(isMetaMediaHost('http://lookaside.fbsbx.com/x'), false);
  fs.rmSync(dir, { recursive: true });
});
