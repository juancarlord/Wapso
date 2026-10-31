// Meta WhatsApp webhook helpers (P-009 K4). Pure: no '@/' imports, testable with node --test.
import crypto from 'node:crypto';
import type { ContactInput, StoredMessage } from './inbox-store';

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

/** X-Hub-Signature-256 = 'sha256=' + hex HMAC-SHA256(rawBody, appSecret). */
export function verifySignature(rawBody: string | Buffer, header: string | null | undefined, appSecret: string | undefined): boolean {
  if (!appSecret || !header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(header.toLowerCase(), expected);
}

export function verifyChallenge(params: URLSearchParams, verifyToken: string | undefined): string | null {
  if (!verifyToken || params.get('hub.mode') !== 'subscribe') return null;
  const token = params.get('hub.verify_token') ?? '';
  const challenge = params.get('hub.challenge');
  return safeEqual(token, verifyToken) && challenge ? challenge : null;
}

/** Key for a NEW contact: phone, else BSUID, else @username, else id. Never username alone when a BSUID exists.
 *  Existing contacts keep their key: resolveContact() (inbox-store.ts) looks them up by BSUID, phone, then username first. */
export function keyFor(phone?: string | null, username?: string | null, bsuid?: string | null, fallbackId?: string | null): string {
  return phone || bsuid || (username ? `@${username}` : '') || fallbackId || 'unknown';
}

/** Identity change carried by a type:'system' message (user_changed_number / user_changed_user_id). */
export type IdentityChange = { kind: string; newPhone: string | null; newBsuid: string | null; previousBsuid: string | null };
export type ParsedInbound = { contact: ContactInput; message: StoredMessage; raw: unknown; change?: IdentityChange };
export type WebhookError = { code: number | null; title: string | null };
export type ParsedStatus = { waMessageId: string; status: string; ts: number; errorCode: number | null; recipient?: string };
export type Parsed = { inbound: ParsedInbound[]; statuses: ParsedStatus[]; errors: WebhookError[]; ignored: number };

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const MEDIA = ['image', 'video', 'audio', 'document', 'sticker'] as const;

export function mapInboundMessage(m: AnyObj, contacts: AnyObj[]): ParsedInbound | null {
  const id = str(m.id);
  if (!id) return null;
  const c = contacts.find((x) => x?.wa_id === m.from || (m.from_user_id && x?.user_id === m.from_user_id)) ?? contacts[0] ?? {};
  const phone = str(c.wa_id) ?? (typeof m.from === 'string' && /^\d+$/.test(m.from) ? m.from : null);
  const username = str(c.profile?.username) ?? str(c.username);
  const bsuid = str(c.user_id) ?? str(m.from_user_id);
  const key = keyFor(phone, username, bsuid, str(m.from));
  const type = str(m.type) ?? 'unknown';
  const msg: StoredMessage = { waMessageId: id, conversationId: key, direction: 'inbound', type, ts: Number(m.timestamp) * 1000 || Date.now(), source: 'webhook' };
  if (type === 'text') msg.body = str(m.text?.body);
  else if ((MEDIA as readonly string[]).includes(type)) {
    const md = m[type] ?? {};
    msg.mediaId = str(md.id); msg.mediaMime = str(md.mime_type); msg.caption = str(md.caption); msg.mediaFilename = str(md.filename);
  } else if (type === 'reaction') { msg.reaction = str(m.reaction?.emoji); msg.replyTo = str(m.reaction?.message_id); }
  else if (type === 'location') {
    const l = m.location ?? {};
    msg.body = [l.name, l.address, l.latitude != null ? `${l.latitude},${l.longitude}` : null].filter(Boolean).join(' · ') || null;
  } else if (type === 'contacts') msg.body = (m.contacts ?? []).map((x: AnyObj) => x?.name?.formatted_name).filter(Boolean).join(', ') || null;
  else if (type === 'interactive') msg.body = str(m.interactive?.button_reply?.title) ?? str(m.interactive?.list_reply?.title) ?? str(m.interactive?.nfm_reply?.body);
  else if (type === 'button') msg.body = str(m.button?.text);
  let change: IdentityChange | undefined;
  if (type === 'system') {
    const sy = m.system ?? {};
    msg.body = str(sy.body);
    const newPhone = str(sy.wa_id), newBsuid = str(sy.user_id), previousBsuid = str(sy.previous_user_id);
    if (newPhone || newBsuid) change = { kind: str(sy.type) ?? 'system', newPhone, newBsuid, previousBsuid };
  } // unsupported / unknown types keep body null; errors[0] is stored below
  const err = firstError(m.errors);
  if (err) { msg.errorCode = err.code; msg.errorTitle = err.title; }
  if (!msg.replyTo) msg.replyTo = str(m.context?.id);
  return { contact: { key, waId: phone, phone, username, bsuid, name: str(c.profile?.name) }, message: msg, raw: m, ...(change ? { change } : {}) };
}

function firstError(errors: unknown): WebhookError | null {
  if (!Array.isArray(errors) || !errors[0]) return null;
  const e = errors[0] as AnyObj;
  return { code: typeof e.code === 'number' ? e.code : null, title: str(e.title) ?? str(e.message) };
}

/** Parse a webhook body; only changes for our phone number id are kept. */
export function parseWebhook(body: unknown, phoneNumberId: string | undefined): Parsed {
  const out: Parsed = { inbound: [], statuses: [], errors: [], ignored: 0 };
  const entries = Array.isArray((body as AnyObj)?.entry) ? (body as AnyObj).entry : [];
  for (const e of entries) for (const ch of Array.isArray(e?.changes) ? e.changes : []) {
    const v = ch?.value ?? {};
    if (!phoneNumberId || v?.metadata?.phone_number_id !== phoneNumberId) { out.ignored++; continue; }
    if (Array.isArray(v.errors)) for (const e of v.errors) { const x = firstError([e]); if (x) out.errors.push(x); }
    const contacts = Array.isArray(v.contacts) ? v.contacts : [];
    const own = str(v?.metadata?.display_phone_number)?.replace(/\D/g, '') ?? null;
    for (const m of Array.isArray(v.messages) ? v.messages : []) {
      if (own && typeof m?.from === 'string' && m.from === own) { out.ignored++; continue; } // our own number: never an inbound user message
      const p = mapInboundMessage(m, contacts);
      if (p) out.inbound.push(p); else out.ignored++;
    }
    for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
      if (!str(s?.id) || !str(s?.status)) { out.ignored++; continue; }
      const code = Array.isArray(s.errors) && typeof s.errors[0]?.code === 'number' ? s.errors[0].code : null;
      out.statuses.push({ waMessageId: s.id, status: s.status, ts: Number(s.timestamp) * 1000 || Date.now(), errorCode: code, recipient: str(s.recipient_id) ?? undefined });
    }
  }
  return out;
}
