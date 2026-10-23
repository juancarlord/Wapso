import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Opaque, encrypted tokens for media that only has a storage URL (no WhatsApp media id),
// so the raw Kapso/CDN URL never reaches the browser.
const TTL_MS = 12 * 60 * 60 * 1000;
const ALLOWED_HOST_SUFFIXES = ['kapso.ai', 'fbsbx.com', 'whatsapp.net'];
// Kapso's file storage (Rails active_storage redirects here). Allowed only as a redirect target.
const REDIRECT_ONLY_HOST_SUFFIXES = ['r2.cloudflarestorage.com'];
const MAX_REDIRECTS = 3;

function key(): Buffer | null {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) return null;
  return Buffer.from(hkdfSync('sha256', s, Buffer.alloc(0), 'wapso-media-token', 32));
}

function hostMatches(url: string, suffixes: string[]): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    return suffixes.some((s) => h === s || h.endsWith(`.${s}`));
  } catch {
    return false;
  }
}

export function isAllowedMediaHost(url: string): boolean {
  return hostMatches(url, ALLOWED_HOST_SUFFIXES);
}

const FETCH_TIMEOUT_MS = 15_000;

/** True when a safeMediaFetch hop hit its 15 s timeout (map to 504). */
export function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

/**
 * SSRF-safe fetch: manual redirects (max 3), each Location resolved against the current URL and
 * re-checked for https + host allowlist. Returns null if any hop is not allowed or the chain is too long.
 */
export async function safeMediaFetch(startUrl: string): Promise<Response | null> {
  if (!isAllowedMediaHost(startUrl)) return null;
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status < 300 || res.status >= 400) return res;
    await res.body?.cancel();
    const loc = res.headers.get('location');
    if (!loc || hop === MAX_REDIRECTS) return null;
    let next: string;
    try { next = new URL(loc, url).toString(); } catch { return null; }
    if (!hostMatches(next, [...ALLOWED_HOST_SUFFIXES, ...REDIRECT_ONLY_HOST_SUFFIXES])) return null;
    url = next;
  }
  return null;
}

export function sealMediaUrl(url: string): string | null {
  const k = key();
  if (!k || !isAllowedMediaHost(url)) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([c.update(JSON.stringify({ u: url, e: Date.now() + TTL_MS }), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

export function openMediaToken(token: string): string | null {
  const k = key();
  if (!k) return null;
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 29) return null;
    const d = createDecipheriv('aes-256-gcm', k, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    const { u, e } = JSON.parse(json) as { u: string; e: number };
    if (typeof u !== 'string' || typeof e !== 'number' || e < Date.now() || !isAllowedMediaHost(u)) return null;
    return u;
  } catch {
    return null;
  }
}

/** Types the browser may render inline. Explicit allowlist: no SVG or other scriptable image types. */
const INLINE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
function isInlineSafe(contentType: string): boolean {
  const t = contentType.split(';')[0].trim().toLowerCase();
  return INLINE_IMAGE.has(t) || /^(audio|video)\/[a-z0-9.+-]+$/.test(t) || t === 'application/pdf';
}

/**
 * Content-Disposition with a safe ASCII fallback name. Downloads (?dl=1) and every type that is not
 * image/audio/video/PDF are forced to `attachment`; inline-safe types without ?dl=1 get no header.
 */
export function contentDisposition(filename: string | null, download: boolean, contentType: string): string | undefined {
  if (!download && isInlineSafe(contentType)) return undefined;
  const name = (filename || 'archivo').replace(/[\u0000-\u001f\u007f\\;"]/g, '').trim().slice(0, 150) || 'archivo';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
