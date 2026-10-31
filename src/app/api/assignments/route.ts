import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getDb, getUserById } from '@/lib/db';
import { clearOffShift } from '@/lib/shift';
import { safeError } from '@/lib/log';
import { assignTo, getAssignment, isValidKey, reopen, resolve } from '@/lib/assignments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET ?key=<contact key> -> current assignment for that chat.
export async function GET(request: Request) {
  const me = await requireUser(request);
  if (me instanceof NextResponse) return me;
  const key = new URL(request.url).searchParams.get('key');
  if (!isValidKey(key)) return NextResponse.json({ error: 'key inválido' }, { status: 400 });
  return NextResponse.json({ assignment: getAssignment(key), me: { id: me.id, role: me.role } });
}

type Action = 'take' | 'release' | 'transfer' | 'resolve' | 'reopen';
const ACTIONS: Action[] = ['take', 'release', 'transfer', 'resolve', 'reopen'];

// POST { key, action, userId? }. Origin is checked by middleware for all non-GET /api calls.
export async function POST(request: Request) {
  const me = await requireUser(request);
  if (me instanceof NextResponse) return me;
  const body = await request.json().catch(() => ({}));
  const key = body?.key;
  const action = body?.action as Action;
  if (!isValidKey(key)) return NextResponse.json({ error: 'key inválido' }, { status: 400 });
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });

  const a = getAssignment(key);
  const isManager = me.role === 'admin' || me.role === 'lead';
  const isMine = a.assignedUserId === me.id;
  const unassigned = a.assignedUserId == null;
  const forbid = (msg: string) => NextResponse.json({ error: msg }, { status: 403 });

  switch (action) {
    case 'take':
      if (!unassigned && !isMine && !isManager) return forbid(`Este chat ya está asignado a ${a.assignedName ?? 'otro usuario'}`);
      assignTo(key, me.id);
      try { clearOffShift(getDb(), key); } catch (e) { safeError('off-shift', e); }
      break;
    case 'release':
      if (unassigned) break;
      if (!isMine && !isManager) return forbid('Solo el agente asignado, un Líder o un Administrador puede liberar este chat');
      assignTo(key, null);
      break;
    case 'transfer': {
      if (!isMine && !isManager && !unassigned) return forbid('Solo el agente asignado, un Líder o un Administrador puede transferir este chat');
      if (unassigned && !isManager) return forbid('Toma el chat antes de transferirlo');
      const target = Number.isInteger(body?.userId) ? getUserById(body.userId) : undefined;
      if (!target || !target.active) return NextResponse.json({ error: 'Usuario destino inválido' }, { status: 400 });
      assignTo(key, target.id);
      break;
    }
    case 'resolve':
      if (!unassigned && !isMine && !isManager) return forbid(`Solo ${a.assignedName ?? 'el agente asignado'}, un Líder o un Administrador puede resolver este chat`);
      if (a.status !== 'resolved') resolve(key, me);
      break;
    case 'reopen':
      if (a.status === 'resolved') reopen(key);
      break;
  }
  return NextResponse.json({ ok: true, assignment: getAssignment(key) });
}
