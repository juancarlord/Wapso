import { NextResponse, type NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '@/lib/password';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, getAuthSecret, signSession, cookieOptions } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const u = await getSessionUser(req);
  const secret = getAuthSecret();
  if (!u || !secret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const current = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
  const next = typeof body?.newPassword === 'string' ? body.newPassword : '';
  if (!(await verifyPassword(current, u.password_hash))) {
    return NextResponse.json({ error: 'La contraseña actual no es correcta' }, { status: 400 });
  }
  if (next.length < MIN_PASSWORD_LENGTH || next.length > 200) {
    return NextResponse.json({ error: `La nueva contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres` }, { status: 400 });
  }
  if (next === current) return NextResponse.json({ error: 'La nueva contraseña debe ser distinta' }, { status: 400 });
  const hash = await hashPassword(next);
  getDb().prepare("UPDATE users SET password_hash=?, must_change_password=0, session_version=session_version+1, updated_at=datetime('now') WHERE id=?").run(hash, u.id);
  // Other sessions are invalidated by the version bump; re-issue this one.
  const token = await signSession({ id: u.id, v: u.session_version + 1 }, secret);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_SECONDS));
  return res;
}
