// Outbound bookkeeping for INBOX_SOURCE=local (P-009 K6): 24 h window check and storing sent messages.
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { upsertMessage, type StoredMessage } from '@/lib/inbox-store';
import { IS_LOCAL, PHONE_NUMBER_ID, whatsappClient } from '@/lib/whatsapp-client';
import { friendlySendError, graphErrorCode, readReceiptInput, shouldSendTyping } from '@/lib/send-rules';
import { safeError } from '@/lib/log';
import { clearOffShift } from '@/lib/shift';

export const WINDOW_MS = 24 * 3600_000;

/** Resolve a recipient (phone, +phone or BSUID) to our contact/conversation key. */
export function recipientKey(to: string): string {
  const t = to.trim().replace(/^\+(?=\d+$)/, '');
  // Existing contact first (keys stay stable after a number/BSUID change), else the phone itself.
  const row = getDb().prepare('SELECT key FROM contacts WHERE key = ? OR bsuid = ? OR wa_id = ? OR phone = ? LIMIT 1').get(t, t, t, t) as { key: string } | undefined;
  return row?.key ?? t;
}

/** 409 window_closed when the last inbound is older than 24 h (local mode only; templates are exempt). */
export function windowClosed(to: string, now = Date.now()): NextResponse | null {
  if (!IS_LOCAL) return null;
  const row = getDb().prepare('SELECT last_inbound_at AS t FROM conversations WHERE id = ?').get(recipientKey(to)) as { t: number | null } | undefined;
  if (row?.t && now - Number(row.t) <= WINDOW_MS) return null;
  return NextResponse.json({ error: 'window_closed' }, { status: 409 });
}

/** Map Graph error 131047 (re-engagement) to the same 409. */
export function isWindowError(e: unknown): boolean {
  if (graphErrorCode(e) === 131047) return true;
  const s = e instanceof Error ? e.message : String(e);
  return /131047/.test(s);
}

/** NextResponse for a known Graph error code (Spanish), or null. */
export function friendlyResponse(code: number | null): NextResponse | null {
  const f = friendlySendError(code);
  return f ? NextResponse.json({ error: f.error, code: f.code }, { status: f.status }) : null;
}

const typingAt = new Map<string, number>();

/** Local mode: mark the latest inbound message as read. With typing=true also shows the typing indicator
 *  (throttled per conversation; Meta's typing call is a read receipt + typing_indicator). Never throws. */
export async function markLatestInboundRead(conversationId: string, typing = false): Promise<void> {
  if (!IS_LOCAL) return;
  if (typing) {
    const now = Date.now();
    if (!shouldSendTyping(typingAt.get(conversationId), now)) return;
    typingAt.set(conversationId, now);
    if (typingAt.size > 5000) typingAt.clear();
  }
  try {
    const row = getDb().prepare("SELECT wa_message_id AS id FROM messages WHERE conversation_id = ? AND direction = 'inbound' ORDER BY ts DESC LIMIT 1").get(conversationId) as { id: string } | undefined;
    if (!row?.id) return;
    await whatsappClient.messages.markRead(readReceiptInput(PHONE_NUMBER_ID, row.id, typing));
  } catch (e) { safeError('mark-read', e, { code: graphErrorCode(e) }); }
}

export function storeOutbound(to: string, waMessageId: string | undefined, m: Omit<StoredMessage, 'waMessageId' | 'conversationId' | 'direction' | 'ts' | 'source'>) {
  if (!IS_LOCAL || !waMessageId) return;
  try {
    const key = recipientKey(to);
    upsertMessage(getDb(), { key, phone: /^\d+$/.test(key) ? key : null, waId: /^\d+$/.test(key) ? key : null },
      { ...m, waMessageId, conversationId: key, direction: 'outbound', ts: Date.now(), source: 'send', status: 'sent' });
    clearOffShift(getDb(), key); // agent replied: leaves "Fuera de turno"
  } catch (e) { safeError('outbound-store', e); }
}
