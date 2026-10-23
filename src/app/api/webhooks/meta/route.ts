// Meta WhatsApp Cloud API webhook (P-009 K4). Public route: authenticated by X-Hub-Signature-256, not by session.
import { getDb } from '@/lib/db';
import { alert } from '@/lib/alert';
import { safeError } from '@/lib/log';
import { applyStatus, recordWebhookError, resolveContact, upsertMessage } from '@/lib/inbox-store';
import { parseWebhook, verifyChallenge, verifySignature } from '@/lib/meta-webhook';
import { enqueueMedia, requeuePending } from '@/lib/media-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const g = globalThis as unknown as { __mediaRequeued?: boolean };
const onMediaFail = (j: { waMessageId: string }) => { void alert('media_download_failed', { wa_message_id: j.waMessageId }); };

export async function GET(request: Request) {
  const challenge = verifyChallenge(new URL(request.url).searchParams, process.env.META_WEBHOOK_VERIFY_TOKEN);
  return challenge
    ? new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
    : new Response('Forbidden', { status: 403 });
}

const MAX_BODY = 4 * 1024 * 1024; // Meta: webhook payloads can be up to 3 MB. Media is fetched separately.

async function readCapped(request: Request): Promise<Buffer | null> {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks); // raw bytes: the signature is over exactly these
}

export async function POST(request: Request) {
  const raw = await readCapped(request);
  if (raw === null) return new Response('Payload Too Large', { status: 413 });
  if (!verifySignature(raw, request.headers.get('x-hub-signature-256'), process.env.META_APP_SECRET)) {
    void alert('webhook_bad_signature');
    return new Response('Unauthorized', { status: 401 });
  }
  try {
    const parsed = parseWebhook(JSON.parse(raw.toString('utf8')), process.env.PHONE_NUMBER_ID);
    const db = getDb();
    let inserted = 0;
    for (const p of parsed.inbound) {
      const contact = resolveContact(db, p.contact, p.change);
      p.message.conversationId = contact.key; // one chat per contact; stable key across number/BSUID changes
      if (upsertMessage(db, contact, p.message, p.raw)) {
        inserted++;
        if (p.message.mediaId) enqueueMedia(db, { waMessageId: p.message.waMessageId, mediaId: p.message.mediaId }, onMediaFail);
      }
    }
    for (const e of parsed.errors) {
      recordWebhookError(db, e);
      void alert('webhook_error', { code: e.code });
    }
    for (const s of parsed.statuses) {
      applyStatus(db, s.waMessageId, s.status, s.ts, s.errorCode);
      if (s.status === 'failed') void alert('send_failed', { code: s.errorCode });
    }
    if (!g.__mediaRequeued) { g.__mediaRequeued = true; requeuePending(db, onMediaFail); }
    console.log(`[webhook] in=${parsed.inbound.length} new=${inserted} statuses=${parsed.statuses.length} errors=${parsed.errors.length} ignored=${parsed.ignored}`);
  } catch (e) {
    safeError('webhook', e);
    void alert('webhook_processing');
  }
  // Always 200 after a valid signature: Meta retries non-200 and inserts are idempotent.
  return new Response('OK', { status: 200 });
}
