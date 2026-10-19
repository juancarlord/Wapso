import { requireUser } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { whatsappClient, PHONE_NUMBER_ID } from '@/lib/whatsapp-client';
import { contentDisposition, isTimeoutError, isAllowedMediaHost, safeMediaFetch } from '@/lib/media-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  const authUser = await requireUser(request);
  if (authUser instanceof NextResponse) return authUser;

  const { mediaId } = await params;
  try {
    const metadata = await whatsappClient.media.get({ mediaId, phoneNumberId: PHONE_NUMBER_ID });

    // Meta's lookaside `url` needs a Meta access token (it returns a small 401 JSON otherwise).
    // Kapso returns a short-lived, pre-signed `downloadUrl` on its own host: fetch that server-side.
    const downloadUrl = (metadata as { downloadUrl?: unknown }).downloadUrl;
    if (typeof downloadUrl !== 'string' || !isAllowedMediaHost(downloadUrl)) {
      console.error('[media] no usable downloadUrl for media');
      return NextResponse.json({ error: 'Media unavailable' }, { status: 502, headers: NO_STORE });
    }
    const upstream = await safeMediaFetch(downloadUrl);
    if (!upstream) {
      console.error('[media] redirect chain rejected');
      return NextResponse.json({ error: 'Media unavailable' }, { status: 502, headers: NO_STORE });
    }
    const upstreamType = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !upstream.body || upstreamType.includes('application/json')) {
      console.error('[media] upstream failed', upstream.status, upstreamType);
      await upstream.body?.cancel();
      return NextResponse.json({ error: 'Media unavailable' }, { status: 502, headers: NO_STORE });
    }

    const sp = new URL(request.url).searchParams;
    const headers: Record<string, string> = {
      ...NO_STORE,
      'Content-Type': upstreamType || metadata.mimeType || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    };
    const len = upstream.headers.get('content-length');
    if (len) headers['Content-Length'] = len;
    const cd = contentDisposition(sp.get('name'), sp.get('dl') === '1', headers['Content-Type']);
    if (cd) headers['Content-Disposition'] = cd;
    return new NextResponse(upstream.body, { headers });
  } catch (error) {
    if (isTimeoutError(error)) {
      console.error('[media] upstream timeout');
      return NextResponse.json({ error: 'Media timeout' }, { status: 504, headers: NO_STORE });
    }
    console.error('[media] fetch failed', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Failed to fetch media' }, { status: 500, headers: NO_STORE });
  }
}
