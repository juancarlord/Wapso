import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Any role: minimal list of active users for chat transfer. Only id + display name.
export async function GET(request: Request) {
  const me = await requireUser(request);
  if (me instanceof NextResponse) return me;
  const rows = getDb()
    .prepare("SELECT id, COALESCE(NULLIF(name, ''), username) AS name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE")
    .all() as { id: number; name: string }[];
  return NextResponse.json({ users: rows.map((r) => ({ id: Number(r.id), name: r.name })) });
}
