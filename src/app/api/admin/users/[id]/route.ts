import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { countActiveAdmins, getDb, getUserById } from '@/lib/db';
import { hashPassword, MIN_PASSWORD_LENGTH } from '@/lib/password';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PATCH body: { action: 'deactivate' | 'reactivate' | 'reset_password' | 'set_role', password?, role? }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const id = Number((await params).id);
  const target = Number.isInteger(id) ? getUserById(id) : undefined;
  if (!target) return NextResponse.json({ error: 'Usuario no encontrado' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const db = getDb();
  const isSelf = target.id === admin.id;
  const lastAdmin = target.role === 'admin' && target.active === 1 && countActiveAdmins() <= 1;

  switch (body?.action) {
    case 'deactivate':
      if (isSelf) return NextResponse.json({ error: 'No puedes desactivar tu propia cuenta' }, { status: 400 });
      if (lastAdmin) return NextResponse.json({ error: 'Debe quedar al menos un administrador activo' }, { status: 400 });
      db.prepare("UPDATE users SET active=0, session_version=session_version+1, updated_at=datetime('now') WHERE id=?").run(id);
      break;
    case 'reactivate':
      db.prepare("UPDATE users SET active=1, must_change_password=1, updated_at=datetime('now') WHERE id=?").run(id);
      break;
    case 'reset_password': {
      const pw = typeof body?.password === 'string' ? body.password : '';
      if (pw.length < MIN_PASSWORD_LENGTH || pw.length > 200) {
        return NextResponse.json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres` }, { status: 400 });
      }
      const hash = await hashPassword(pw);
      db.prepare("UPDATE users SET password_hash=?, must_change_password=?, session_version=session_version+1, updated_at=datetime('now') WHERE id=?")
        .run(hash, isSelf ? 0 : 1, id);
      break;
    }
    case 'set_role': {
      const role = body?.role === 'admin' ? 'admin' : body?.role === 'agent' ? 'agent' : null;
      if (!role) return NextResponse.json({ error: 'Rol inválido' }, { status: 400 });
      if (role === 'agent' && isSelf) return NextResponse.json({ error: 'No puedes quitarte el rol de administrador' }, { status: 400 });
      if (role === 'agent' && lastAdmin) return NextResponse.json({ error: 'Debe quedar al menos un administrador activo' }, { status: 400 });
      db.prepare("UPDATE users SET role=?, updated_at=datetime('now') WHERE id=?").run(role, id);
      break;
    }
    default:
      return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
