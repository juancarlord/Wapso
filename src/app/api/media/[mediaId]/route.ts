import { requireUser } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { whatsappClient, PHONE_NUMBER_ID, IS_LOCAL } from '@/lib/whatsapp-client';
import { getDb } from '@/lib/db';
import { mediaDir } from '@/lib/media-store';
import { openMediaSource } from '@/lib/media-source';
import { bucketConfig } from '@/lib/bucket';
import { safeError } from '@/lib/log';
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
  if (IS_LOCAL) return serveLocal(request, mediaId);
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
      safeError('media', new Error('upstream failed'), { status: upstream.status, type: upstreamType.slice(0, 60) });
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
    safeError('media', error);
    return NextResponse.json({ error: 'Failed to fetch media' }, { status: 500, headers: NO_STORE });
  }
}

/** INBOX_SOURCE=local: stream from MEDIA_DIR, else (tiered) stream from the private bucket server-side.
 *  Same auth (above), Content-Type, Content-Disposition (H1 allowlist) and nosniff either way. Never redirects. 404 if neither. */
async function serveLocal(request: Request, mediaId: string) {
  const db = getDb();
  const row = (mediaId.startsWith('local:')
    ? db.prepare('SELECT media_path AS p, media_mime AS m, media_object_key AS k FROM messages WHERE wa_message_id = ?').get(mediaId.slice(6))
    : db.prepare('SELECT media_path AS p, media_mime AS m, media_object_key AS k FROM messages WHERE media_id = ? AND media_path IS NOT NULL LIMIT 1').get(mediaId)) as
    { p: string | null; m: string | null; k: string | null } | undefined;
  if (!row?.p) return NextResponse.json({ error: 'Media not found' }, { status: 404, headers: NO_STORE });
  // Deduped files are shared: any row with the same file may carry the object key.
  const key = row.k ?? ((db.prepare('SELECT media_object_key AS k FROM messages WHERE media_path = ? AND media_object_key IS NOT NULL LIMIT 1').get(row.p) as { k: string } | undefined)?.k ?? null);
  let src;
  try {
    src = await openMediaSource({ dir: mediaDir(), rel: row.p, objectKey: key, cfg: bucketConfig() });
  } catch (e) {
    if (isTimeoutError(e)) return NextResponse.json({ error: 'Media timeout' }, { status: 504, headers: NO_STORE });
    console.error('[media] bucket fetch failed');
    return NextResponse.json({ error: 'Media unavailable' }, { status: 502, headers: NO_STORE });
  }
  if (!src) return NextResponse.json({ error: 'Media not found' }, { status: 404, headers: NO_STORE });
  const type = row.m || 'application/octet-stream'; // our stored type, never the bucket's
  const headers: Record<string, string> = { ...NO_STORE, 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' };
  if (src.size != null && Number.isFinite(src.size)) headers['Content-Length'] = String(src.size);
  const sp = new URL(request.url).searchParams;
  const cd = contentDisposition(sp.get('name'), sp.get('dl') === '1', type);
  if (cd) headers['Content-Disposition'] = cd;
  return new NextResponse(src.body, { headers });
}
