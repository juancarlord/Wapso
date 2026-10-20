import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { LATEST_RELEASE_ID, RELEASES } from '@/lib/releases';
import { getLastSeenRelease, setLastSeenRelease } from '@/lib/release-seen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const me = await requireUser(request);
  if (me instanceof NextResponse) return me;
  const lastSeen = getLastSeenRelease(me.id);
  return NextResponse.json({ latest: LATEST_RELEASE_ID, lastSeen, unseen: !!LATEST_RELEASE_ID && lastSeen !== LATEST_RELEASE_ID });
}

// POST { id } -> marks that release seen. Origin is checked by middleware for all non-GET /api calls.
export async function POST(request: Request) {
  const me = await requireUser(request);
  if (me instanceof NextResponse) return me;
  const body = await request.json().catch(() => ({}));
  const id = typeof body?.id === 'string' ? body.id : '';
  if (!RELEASES.some((r) => r.id === id)) return NextResponse.json({ error: 'Versión inválida' }, { status: 400 });
  setLastSeenRelease(me.id, id);
  return NextResponse.json({ ok: true });
}
