import { NextResponse, type NextRequest } from 'next/server';
import { canAssignRole, canManage, requireManager } from '@/lib/auth';
import { countActiveAdmins, getDb, getUserById, ROLES, type Role, type UserRow } from '@/lib/db';
import { hashPassword, MIN_PASSWORD_LENGTH } from '@/lib/password';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const err = (error: string, status: number) => NextResponse.json({ error }, { status });

async function loadTarget(req: NextRequest, params: Promise<{ id: string }>) {
  const actor = await requireManager(req);
  if (actor instanceof NextResponse) return actor;
  const id = Number((await params).id);
  const target = Number.isInteger(id) ? getUserById(id) : undefined;
  if (!target) return err('Usuario no encontrado', 404);
  if (!canManage(actor, target)) return err('No tienes permiso sobre este usuario', 403);
  return { actor, target };
}

const isLastActiveAdmin = (t: UserRow) => t.role === 'admin' && t.active === 1 && countActiveAdmins() <= 1;

// PATCH body: { action: 'deactivate' | 'reactivate' | 'reset_password' | 'set_role', password?, role? }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await loadTarget(req, params);
  if (ctx instanceof NextResponse) return ctx;
  const { actor, target } = ctx;
  const body = await req.json().catch(() => ({}));
  const db = getDb();
  const isSelf = target.id === actor.id;

  switch (body?.action) {
    case 'deactivate':
      if (isSelf) return err('No puedes desactivar tu propia cuenta', 400);
      if (isLastActiveAdmin(target)) return err('Debe quedar al menos un administrador activo', 400);
      db.prepare("UPDATE users SET active=0, session_version=session_version+1, updated_at=datetime('now') WHERE id=?").run(target.id);
      break;
    case 'reactivate':
      db.prepare("UPDATE users SET active=1, must_change_password=1, session_version=session_version+1, updated_at=datetime('now') WHERE id=?").run(target.id);
      break;
    case 'reset_password': {
      if (isSelf) return err('No puedes restablecer tu propia contraseña aquí; usa Cambiar contraseña', 400);
      const pw = typeof body?.password === 'string' ? body.password : '';
      if (pw.length < MIN_PASSWORD_LENGTH || pw.length > 200) {
        return err(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`, 400);
      }
      const hash = await hashPassword(pw);
      db.prepare("UPDATE users SET password_hash=?, must_change_password=?, session_version=session_version+1, updated_at=datetime('now') WHERE id=?")
        .run(hash, 1, target.id);
      break;
    }
    case 'set_role': {
      const role: Role | null = ROLES.includes(body?.role) ? body.role : null;
      if (!role) return err('Rol inválido', 400);
      // Leads can't change roles at all (a lead's only target is an agent, and the only role it may assign is agent).
      if (actor.role !== 'admin' || !canAssignRole(actor, role)) return err('No tienes permiso para asignar ese rol', 403);
      if (isSelf && role !== actor.role) return err('No puedes cambiar tu propio rol', 400);
      if (role !== 'admin' && isLastActiveAdmin(target)) return err('Debe quedar al menos un administrador activo', 400);
      db.prepare("UPDATE users SET role=?, session_version=session_version+1, updated_at=datetime('now') WHERE id=?").run(role, target.id);
      break;
    }
    default:
      return err('Acción inválida', 400);
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await loadTarget(req, params);
  if (ctx instanceof NextResponse) return ctx;
  const { actor, target } = ctx;
  if (target.id === actor.id) return err('No puedes eliminar tu propia cuenta', 400);
  if (isLastActiveAdmin(target)) return err('Debe quedar al menos un administrador activo', 400);
  // The row is gone, so any session for this user fails the lookup on its next request.
  getDb().prepare('DELETE FROM users WHERE id=?').run(target.id);
  return NextResponse.json({ ok: true });
}
