/** Stable per-contact key (client + server): phone, else WhatsApp username, else first Kapso id. Never contactName (not unique). */
export function contactKey(c: { id: string; phoneNumber?: string | null; username?: string | null }): string {
  return c.phoneNumber || (c.username ? `@${c.username}` : '') || c.id.split(',')[0];
}
