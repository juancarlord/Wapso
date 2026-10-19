// Signed session tokens (HMAC-SHA256 via Web Crypto). Payload: user id + session version.
export const SESSION_COOKIE = 'inbox_session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export type SessionPayload = { id: number; v: number; exp: number };

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str: string): Uint8Array {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Returns the secret, or null if missing/too short (callers must fail closed). */
export function getAuthSecret(): string | null {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) return null;
  return s;
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(payload: Omit<SessionPayload, 'exp'>, secret: string): Promise<string> {
  const full: SessionPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const body = b64url(enc.encode(JSON.stringify(full)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verifySession(token: string | undefined, secret: string): Promise<SessionPayload | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(parts[1]) as BufferSource, enc.encode(parts[0]));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]))) as SessionPayload;
    if (typeof p.exp !== 'number' || p.exp < Math.floor(Date.now() / 1000)) return null;
    if (!Number.isInteger(p.id) || !Number.isInteger(p.v)) return null;
    return p;
  } catch {
    return null;
  }
}

let warnedInsecure = false;
function secureCookie(): boolean {
  const insecure = process.env.AUTH_INSECURE_COOKIE === '1';
  if (process.env.NODE_ENV !== 'production') return false;
  if (insecure && !warnedInsecure) {
    warnedInsecure = true;
    console.error('[auth] AUTH_INSECURE_COOKIE=1 is ignored in production; cookies stay Secure.');
  }
  return true;
}

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: secureCookie(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}
