import { NextResponse, type NextRequest } from 'next/server';
import { getDb, getUserByUsername } from '@/lib/db';
import { verifyPassword, DUMMY_HASH } from '@/lib/password';
import { isLimited, recordFailure, clearFailures } from '@/lib/rate-limit';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, getAuthSecret, signSession, cookieOptions } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The LAST X-Forwarded-For entry is the one our proxy (Traefik) appended; earlier ones are client-controlled.
// Next's route handlers don't expose the socket address, so without the header all requests share one bucket.
function clientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  const last = xff?.split(',').map((x) => x.trim()).filter(Boolean).pop();
  return last || 'direct';
}

export async function POST(req: NextRequest) {
  const secret = getAuthSecret();
  if (!secret) return NextResponse.json({ error: 'Auth not configured' }, { status: 503 });

  let username = '';
  let password = '';
  try {
    const body = await req.json();
    username = typeof body?.username === 'string' ? body.username.trim().slice(0, 100) : '';
    password = typeof body?.password === 'string' ? body.password.slice(0, 200) : '';
  } catch {
    return NextResponse.json({ error: 'Solicitud inválida' }, { status: 400 });
  }

  const ip = clientIp(req);
  if (isLimited(ip, username)) {
    return NextResponse.json({ error: 'Demasiados intentos. Intenta de nuevo en 15 minutos.' }, { status: 429 });
  }

  const user = username ? getUserByUsername(username) : undefined;
  const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok || !user.active || !password) {
    recordFailure(ip, username);
    return NextResponse.json({ error: 'Usuario o contraseña incorrectos' }, { status: 401 });
  }

  clearFailures(ip, username);
  getDb().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  const token = await signSession({ id: user.id, v: user.session_version }, secret);
  const res = NextResponse.json({ ok: true, mustChangePassword: !!user.must_change_password });
  res.cookies.set(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_SECONDS));
  return res;
}
