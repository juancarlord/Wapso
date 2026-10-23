import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { markConversationsRead } from '@/lib/db';
import { markLatestInboundRead } from '@/lib/outbound';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST { conversationId: "id" | "id1,id2" } -> marks them read for the current user only.
export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;
  const body = await request.json().catch(() => ({}));
  const raw = typeof body?.conversationId === 'string' ? body.conversationId : '';
  const ids = raw.split(',').map((x: string) => x.trim()).filter((x: string) => /^[A-Za-z0-9._:-]{1,128}$/.test(x)).slice(0, 20);
  if (ids.length === 0) return NextResponse.json({ error: 'conversationId inválido' }, { status: 400 });
  markConversationsRead(user.id, ids);
  // Local mode: blue ticks on the latest inbound message (no typing indicator here). Fire-and-forget; Meta errors never fail this request.
  for (const id of ids) void markLatestInboundRead(id);
  return NextResponse.json({ ok: true });
}
