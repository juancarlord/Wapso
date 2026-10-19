import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getDb, getUserByUsername, toPublic, type UserRow } from '@/lib/db';
import { hashPassword, MIN_PASSWORD_LENGTH } from '@/lib/password';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const rows = getDb().prepare('SELECT * FROM users ORDER BY active DESC, username').all() as UserRow[];
  return NextResponse.json({ users: rows.map(toPublic), me: admin.id });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await req.json().catch(() => ({}));
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 100) : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const role = body?.role === 'admin' ? 'admin' : 'agent';
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    return NextResponse.json({ error: 'Usuario inválido (3-40 caracteres: letras, números, . _ -)' }, { status: 400 });
  }
  if (!name) return NextResponse.json({ error: 'El nombre es obligatorio' }, { status: 400 });
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
    return NextResponse.json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres` }, { status: 400 });
  }
  if (getUserByUsername(username)) return NextResponse.json({ error: 'Ese usuario ya existe' }, { status: 409 });
  const hash = await hashPassword(password);
  const r = getDb()
    .prepare('INSERT INTO users (username, name, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)')
    .run(username, name, hash, role);
  return NextResponse.json({ ok: true, id: Number(r.lastInsertRowid) }, { status: 201 });
}
