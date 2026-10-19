import { NextResponse, type NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const u = await getSessionUser(req);
  if (!u) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ id: u.id, username: u.username, name: u.name, role: u.role, mustChangePassword: !!u.must_change_password });
}
