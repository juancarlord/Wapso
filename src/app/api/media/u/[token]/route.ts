import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { contentDisposition, isTimeoutError, openMediaToken, safeMediaFetch } from '@/lib/media-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const authUser = await requireUser(request);
  if (authUser instanceof NextResponse) return authUser;

  const url = openMediaToken((await params).token);
  if (!url) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });

  try {
    const upstream = await safeMediaFetch(url);
    if (!upstream || !upstream.ok || !upstream.body) {
      await upstream?.body?.cancel();
      return NextResponse.json({ error: 'Failed to fetch media' }, { status: 502, headers: NO_STORE });
    }
    const sp = new URL(request.url).searchParams;
    const headers: Record<string, string> = {
      ...NO_STORE,
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    };
    const len = upstream.headers.get('content-length');
    if (len) headers['Content-Length'] = len;
    const cd = contentDisposition(sp.get('name'), sp.get('dl') === '1', headers['Content-Type']);
    if (cd) headers['Content-Disposition'] = cd;
    return new NextResponse(upstream.body, { headers });
  } catch (error) {
    if (isTimeoutError(error)) {
      return NextResponse.json({ error: 'Media timeout' }, { status: 504, headers: NO_STORE });
    }
    return NextResponse.json({ error: 'Failed to fetch media' }, { status: 502, headers: NO_STORE });
  }
}
