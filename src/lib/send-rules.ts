// Outbound rules (Meta Cloud API media limits + error codes). Pure: no '@/' imports, testable with node --test.
// Media: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
// Errors: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes

export type OutboundMediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker';
export type MediaPlan = { ok: true; type: OutboundMediaType } | { ok: false; error: string };

const MB = 1024 * 1024;
export const MEDIA_LIMITS: Record<OutboundMediaType, number> = {
  image: 5 * MB, video: 16 * MB, audio: 16 * MB, document: 100 * MB, sticker: 500 * 1024,
};
const IMAGE = new Set(['image/jpeg', 'image/png']);
const VIDEO = new Set(['video/mp4', 'video/3gpp']);
const AUDIO = new Set(['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg']);
const LABEL: Record<OutboundMediaType, string> = { image: 'La imagen', video: 'El video', audio: 'El audio', document: 'El documento', sticker: 'El sticker' };

/** Pick the Meta message type for a file. Anything not on the allowlist goes as a document. WebP is a sticker only when asked. */
export function planOutboundMedia(mime: string | null | undefined, size: number, opts: { sticker?: boolean } = {}): MediaPlan {
  const base = (mime || '').split(';')[0].trim().toLowerCase();
  let type: OutboundMediaType = 'document';
  if (IMAGE.has(base)) type = 'image';
  else if (base === 'image/webp' && opts.sticker) type = 'sticker';
  else if (VIDEO.has(base)) type = 'video';
  else if (AUDIO.has(base)) type = 'audio';
  if (!(size > 0)) return { ok: false, error: 'El archivo está vacío.' };
  const max = MEDIA_LIMITS[type];
  if (size > max) {
    const lim = max >= MB ? `${max / MB} MB` : `${max / 1024} KB`;
    return { ok: false, error: `${LABEL[type]} supera el máximo de WhatsApp (${lim}).` };
  }
  return { ok: true, type };
}

/** A BSUID looks like "CO.1234..." (country prefix + dot); phone numbers are digits only. */
export function isBsuid(to: string): boolean {
  const t = to.trim();
  return !/^\+?\d+$/.test(t) && t.includes('.');
}

/** Graph error code from a Graph JSON body, an SDK GraphApiError, or an error message containing "(#131047)". */
export function graphErrorCode(e: unknown): number | null {
  const o = e as { code?: unknown; error?: { code?: unknown }; message?: unknown } | null;
  for (const v of [o?.code, o?.error?.code]) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  const msg = typeof o?.message === 'string' ? o.message : '';
  const m = msg.match(/\(#(\d+)\)/) ?? msg.match(/\b(13\d{4}|80007)\b/);
  return m ? Number(m[1]) : null;
}

export const WAIT_MSG = 'WhatsApp está limitando los envíos. Espere unos segundos e intente de nuevo.';
/** Map known Graph codes to a status + Spanish message. null = unknown (caller keeps its generic error). */
export function friendlySendError(code: number | null): { status: number; error: string; code: number } | null {
  switch (code) {
    case 131047: return { status: 409, error: 'window_closed', code };
    case 130429: case 80007: case 131056: return { status: 429, error: WAIT_MSG, code };
    case 131026: return { status: 422, error: 'No se pudo entregar: el número no tiene WhatsApp o el paciente debe actualizar la app.', code };
    case 131049: return { status: 422, error: 'WhatsApp no entregó la plantilla para cuidar la experiencia del usuario. Intente más tarde o use otra plantilla.', code };
    default: return null;
  }
}

/** Typing indicator throttle: at most one ping per conversation every ~20 s (Meta shows it up to 25 s). */
export const TYPING_INTERVAL_MS = 20_000;
export function shouldSendTyping(lastAt: number | undefined, now: number, interval = TYPING_INTERVAL_MS): boolean {
  return lastAt === undefined || now - lastAt >= interval;
}

/** Meta read receipt input. The typing indicator is opt-in: only when the agent is actually typing. */
export function readReceiptInput(phoneNumberId: string, messageId: string, typing: boolean) {
  return typing
    ? { phoneNumberId, messageId, typingIndicator: { type: 'text' as const } }
    : { phoneNumberId, messageId };
}
