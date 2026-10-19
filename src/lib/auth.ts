import { NextResponse } from 'next/server';
import { SESSION_COOKIE, getAuthSecret, verifySession } from '@/lib/session';
import { getUserById, type UserRow } from '@/lib/db';

/** Resolves the session cookie to an active user whose session version still matches. */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; } }
  }
  return undefined;
}

export async function getSessionUser(req: Request): Promise<UserRow | null> {
  const secret = getAuthSecret();
  if (!secret) return null;
  const s = await verifySession(readCookie(req, SESSION_COOKIE), secret);
  if (!s) return null;
  const u = getUserById(s.id);
  if (!u || !u.active || u.session_version !== s.v) return null;
  return u;
}

/** Expected origin for state-changing requests. Production requires APP_ORIGIN (fail closed). */
export function expectedOrigin(req: Request): string | null {
  const fixed = process.env.APP_ORIGIN?.trim();
  if (fixed) {
    try { return new URL(fixed).origin; } catch { return null; }
  }
  if (process.env.NODE_ENV === 'production') return null;
  const host = req.headers.get('host');
  return host ? `http://${host}` : null;
}

/** CSRF defense on top of SameSite=Lax: Origin must equal the app's own origin. */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  const expected = expectedOrigin(req);
  if (!origin || !expected) return false;
  try {
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}

/** For data routes: active user with no pending password change, else a 401/403 response. */
export async function requireUser(req: Request): Promise<UserRow | NextResponse> {
  const u = await getSessionUser(req);
  if (!u) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (u.must_change_password) return NextResponse.json({ error: 'Password change required' }, { status: 403 });
  return u;
}

export async function requireAdmin(req: Request): Promise<UserRow | NextResponse> {
  const u = await getSessionUser(req);
  if (!u) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (u.must_change_password) return NextResponse.json({ error: 'Password change required' }, { status: 403 });
  if (u.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return u;
}
