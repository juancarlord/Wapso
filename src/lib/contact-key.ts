/** Stable per-contact key (client + server). Never contactName (not unique).
 *  Local mode (INBOX_SOURCE=local): the chat id IS the contact key (phone, BSUID, or a legacy @username from the Kapso export),
 *  passed as chatKey. Kapso mode (no chatKey): phone, else WhatsApp username, else first Kapso id (unchanged). */
export function contactKey(c: { id: string; phoneNumber?: string | null; username?: string | null; chatKey?: string | null }): string {
  if (c.chatKey) return c.chatKey;
  return c.phoneNumber || (c.username ? `@${c.username}` : '') || c.id.split(',')[0];
}
