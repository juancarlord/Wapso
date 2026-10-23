// Reads from our own store for INBOX_SOURCE=local (P-009 K7). Same JSON shape as the Kapso mapping.
import type { DatabaseSync } from 'node:sqlite';

function formatBytes(n?: number): string | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

const iso = (ms: number | null | undefined) => (ms ? new Date(Number(ms)).toISOString() : undefined);
const MEDIA = ['image', 'video', 'audio', 'document', 'sticker'];

type ConvRow = { id: string; contact_key: string; last_message_at: number | null; last_inbound_at: number | null; last_message_preview: string | null;
  last_message_type: string | null; last_direction: string | null; messages_count: number; phone: string | null; username: string | null; name: string | null; bsuid: string | null };

export function listLocalConversations(db: DatabaseSync, phoneNumberId: string, limit = 100) {
  const rows = db.prepare(
    `SELECT v.*, c.phone, c.username, c.name, c.bsuid FROM conversations v JOIN contacts c ON c.key = v.contact_key
     ORDER BY v.last_message_at DESC LIMIT ?`
  ).all(limit) as ConvRow[];
  return rows.map((r) => ({
    id: r.id,
    chatKey: r.id, // local: chat id = contact key (assignments key on it)
    phoneNumber: r.phone ?? '',
    bsuid: r.bsuid ?? '',
    username: r.username ?? null,
    status: 'active',
    lastActiveAt: iso(r.last_message_at),
    phoneNumberId,
    metadata: {},
    lastInboundAt: iso(r.last_inbound_at),
    contactName: r.name ?? undefined,
    messagesCount: Number(r.messages_count),
    lastMessage: r.last_message_preview
      ? { content: r.last_message_preview, direction: (r.last_direction === 'outbound' ? 'outbound' : 'inbound') as 'inbound' | 'outbound', type: r.last_message_type ?? undefined }
      : undefined,
  }));
}

type MsgRow = { wa_message_id: string; direction: string; type: string; body: string | null; caption: string | null; media_id: string | null;
  media_path: string | null; media_mime: string | null; media_size: number | null; media_filename: string | null; reply_to: string | null;
  reaction: string | null; template_name: string | null; status: string | null; ts: number; phone: string | null };

/** Messages for one or more of our conversation ids (comma list, like the Kapso merge), newest `limit`, returned ascending. */
export function listLocalMessages(db: DatabaseSync, conversationIds: string[], limit = 50, before?: number) {
  const ph = conversationIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT m.*, c.phone FROM messages m LEFT JOIN conversations v ON v.id = m.conversation_id LEFT JOIN contacts c ON c.key = v.contact_key
     WHERE m.conversation_id IN (${ph}) ${before ? 'AND m.ts < ?' : ''} ORDER BY m.ts DESC LIMIT ?`
  ).all(...conversationIds, ...(before ? [before] : []), limit) as MsgRow[];
  rows.reverse();
  return rows.map((m) => {
    const isMedia = MEDIA.includes(m.type) || Boolean(m.media_id || m.media_path);
    const src = m.media_id ? `/api/media/${encodeURIComponent(m.media_id)}` : m.media_path ? `/api/media/${encodeURIComponent('local:' + m.wa_message_id)}` : undefined;
    return {
      id: m.wa_message_id,
      direction: m.direction,
      content: m.body ?? m.reaction ?? m.caption ?? (m.template_name ? `[Plantilla: ${m.template_name}]` : ''),
      createdAt: new Date(Number(m.ts)).toISOString(),
      status: m.status ?? undefined,
      phoneNumber: m.phone ?? undefined,
      hasMedia: isMedia,
      mediaData: isMedia && src ? { url: src, filename: m.media_filename ?? undefined, contentType: m.media_mime ?? undefined, byteSize: m.media_size ?? undefined, sizeText: formatBytes(m.media_size ?? undefined) } : undefined,
      reactionEmoji: m.reaction ?? undefined,
      reactedToMessageId: m.type === 'reaction' ? m.reply_to ?? undefined : undefined,
      filename: m.media_filename ?? undefined,
      mimeType: m.media_mime ?? undefined,
      messageType: m.type,
      caption: m.caption ?? undefined,
      metadata: { mediaId: m.media_id ?? undefined },
    };
  });
}
