import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { markLatestInboundRead } from '@/lib/outbound';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST { conversationId } while an agent types in the composer. Local mode only; throttled server-side (~20 s per chat).
// Never fails on Meta errors.
export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;
  const body = await request.json().catch(() => ({}));
  const id = typeof body?.conversationId === 'string' ? body.conversationId.split(',')[0].trim() : '';
  if (!/^[A-Za-z0-9._:@+-]{1,128}$/.test(id)) return NextResponse.json({ error: 'conversationId inválido' }, { status: 400 });
  void markLatestInboundRead(id, true);
  return NextResponse.json({ ok: true });
}
