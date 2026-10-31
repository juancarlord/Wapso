// Async out-of-shift auto-reply sender (P-009-KC KC1). Runs after the webhook has answered 200 to Meta.
import { getDb } from '@/lib/db';
import { alert } from '@/lib/alert';
import { safeError } from '@/lib/log';
import { upsertMessage } from '@/lib/inbox-store';
import { recordAutoReplyOutcome, type AutoReplyJob } from '@/lib/shift';
import { PHONE_NUMBER_ID, whatsappClient } from '@/lib/whatsapp-client';
import { extractSentMessageId } from '@/lib/db';

export const AUTO_SENDER_NAME = 'Respuesta automática';

/** Fire-and-forget: one attempt per job, never retried (the claim row stays), failure → alert only. */
export function sendAutoRepliesLater(jobs: AutoReplyJob[]) {
  if (!jobs.length) return;
  setImmediate(() => { void Promise.allSettled(jobs.map(sendOne)); });
}

async function sendOne(job: AutoReplyJob): Promise<void> {
  const db = getDb();
  try {
    const row = db.prepare('SELECT phone, bsuid FROM contacts WHERE key = ?').get(job.contactKey) as { phone: string | null; bsuid: string | null } | undefined;
    const to = row?.phone || row?.bsuid;
    if (!to) { recordAutoReplyOutcome(db, job, 'failed'); return; }
    const res = await whatsappClient.request('POST', `/${PHONE_NUMBER_ID}/messages`, {
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', ...(row?.phone ? { to } : { recipient: to }), type: 'text', text: { body: job.text } },
    });
    if (!res.ok) {
      let code: number | undefined;
      try { code = ((await res.json()) as { error?: { code?: number } })?.error?.code; } catch { /* not json */ }
      recordAutoReplyOutcome(db, job, 'failed');
      safeError('auto-reply', new Error('send failed'), { status: res.status, code });
      void alert('auto_reply_failed', { status: res.status, code: code ?? null });
      return;
    }
    const id = extractSentMessageId(await res.json());
    recordAutoReplyOutcome(db, job, 'sent', id);
    if (id) {
      // Stored as an outbound system/auto message; it does NOT clear the "Fuera de turno" queue.
      upsertMessage(db, { key: job.contactKey }, { waMessageId: id, conversationId: job.conversationId, direction: 'outbound', type: 'text', body: job.text, ts: Date.now(), source: 'send', status: 'sent' });
      db.prepare('INSERT OR IGNORE INTO message_senders (wa_message_id, user_id, sender_name) VALUES (?, 0, ?)').run(id, AUTO_SENDER_NAME);
    }
  } catch (e) {
    try { recordAutoReplyOutcome(db, job, 'failed'); } catch { /* ignore */ }
    safeError('auto-reply', e);
    void alert('auto_reply_failed');
  }
}
