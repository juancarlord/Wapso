import { NextResponse, type NextRequest } from 'next/server';
import { canAssignRole, requireManager } from '@/lib/auth';
import { getDb, getUserByUsername, toPublic, ROLES, type Role, type UserRow } from '@/lib/db';
import { hashPassword, MIN_PASSWORD_LENGTH } from '@/lib/password';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Admin and lead only (agents use /api/users/active for the transfer list).
export async function GET(req: NextRequest) {
  const me = await requireManager(req);
  if (me instanceof NextResponse) return me;
  const rows = getDb().prepare('SELECT * FROM users ORDER BY active DESC, username').all() as UserRow[];
  const users = rows.map((r) => {
    const pub = toPublic(r);
    if (me.role !== 'agent') return pub;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { last_login_at, ...rest } = pub;
    return rest;
  });
  return NextResponse.json({ users, me: me.id, myRole: me.role });
}

export async function POST(req: NextRequest) {
  const actor = await requireManager(req);
  if (actor instanceof NextResponse) return actor;
  const body = await req.json().catch(() => ({}));
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 100) : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const role: Role | null = body?.role === undefined ? 'agent' : ROLES.includes(body.role) ? body.role : null;
  if (!role) return NextResponse.json({ error: 'Rol inválido' }, { status: 400 });
  if (!canAssignRole(actor, role)) return NextResponse.json({ error: 'No tienes permiso para asignar ese rol' }, { status: 403 });
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
