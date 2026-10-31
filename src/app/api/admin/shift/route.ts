// "Horario y fuera de turno" settings (P-009-KC KC1). Admin only (lead/agent → 403). Origin checked by middleware for PUT.
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { DEFAULT_SHIFT, autoReplyText, getShift, isOpenAt, saveShift, validateShift } from '@/lib/shift';
import { safeError } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireAdmin(req: Request) {
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;
  if (u.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return u;
}

const view = (s = getShift(getDb())) => ({ settings: s, defaults: DEFAULT_SHIFT, openNow: isOpenAt(Date.now(), s), preview: autoReplyText(s) });

export async function GET(request: Request) {
  const me = await requireAdmin(request);
  if (me instanceof NextResponse) return me;
  return NextResponse.json(view());
}

export async function PUT(request: Request) {
  const me = await requireAdmin(request);
  if (me instanceof NextResponse) return me;
  const body = await request.json().catch(() => null);
  try {
    const db = getDb();
    const v = validateShift(body, getShift(db));
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    saveShift(db, v.value);
    console.log(`[shift] settings updated by user=${me.id} enabled=${v.value.enabled}`);
    return NextResponse.json(view(v.value));
  } catch (e) {
    safeError('shift', e);
    return NextResponse.json({ error: 'No se pudo guardar' }, { status: 500 });
  }
}
