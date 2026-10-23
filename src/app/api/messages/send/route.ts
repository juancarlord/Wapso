import { extractSentMessageId, recordMessageSender } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { whatsappClient, PHONE_NUMBER_ID, IS_LOCAL } from '@/lib/whatsapp-client';
import { safeError } from '@/lib/log';
import { alert } from '@/lib/alert';
import { friendlyResponse, isWindowError, storeOutbound, windowClosed } from '@/lib/outbound';
import { graphErrorCode, isBsuid as looksLikeBsuid, planOutboundMedia } from '@/lib/send-rules';
import { storeBytes, mediaDir } from '@/lib/media-store';

export async function POST(request: Request) {
  const authUser = await requireUser(request);
  if (authUser instanceof NextResponse) return authUser;

  try {
    const formData = await request.formData();
    const to = formData.get('to') as string;
    const body = formData.get('body') as string;
    const file = formData.get('file') as File | null;
    const asSticker = formData.get('asSticker') === '1';
    const replyToRaw = formData.get('replyTo');
    const replyTo = typeof replyToRaw === 'string' && /^[A-Za-z0-9._:=+/-]{1,256}$/.test(replyToRaw) ? replyToRaw : null;

    if (!to) {
      return NextResponse.json(
        { error: 'Missing required field: to' },
        { status: 400 }
      );
    }

    const closed = windowClosed(to);
    if (closed) return closed;

    const isBsuid = looksLikeBsuid(to);
    let savedMedia: string | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const basePayload: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...(isBsuid ? { recipient: to } : { to }),
      ...(replyTo ? { context: { message_id: replyTo } } : {})
    };

    // Send media message
    if (file) {
      // Meta allowlist + size limits; anything else goes as a document.
      const plan = planOutboundMedia(file.type, file.size, { sticker: asSticker });
      if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 413 });
      const mediaType = plan.type;

      // Upload media first
      const uploadResult = await whatsappClient.media.upload({
        phoneNumberId: PHONE_NUMBER_ID,
        type: mediaType as 'image' | 'video' | 'audio' | 'document' | 'sticker',
        file: file,
        fileName: file.name
      });

      if (IS_LOCAL) {
        try { savedMedia = storeBytes(mediaDir(), new Uint8Array(await file.arrayBuffer()), file.type); } catch (e) { safeError('send-media-store', e); }
      }
      basePayload.type = mediaType;
      basePayload[mediaType] = { id: uploadResult.id };
      if (body && mediaType !== 'audio' && mediaType !== 'sticker') {
        basePayload[mediaType].caption = body;
      }
      if (mediaType === 'document') {
        basePayload[mediaType].filename = file.name;
      }
    } else if (body) {
      basePayload.type = 'text';
      basePayload.text = { body };
    } else {
      return NextResponse.json(
        { error: 'Either body or file is required' },
        { status: 400 }
      );
    }

    const response = await whatsappClient.request('POST', `/${PHONE_NUMBER_ID}/messages`, {
      body: basePayload
    });

    if (!response.ok) {
      // Never log the body: it can echo the recipient and message text. Status + Graph error code only.
      let code: number | undefined;
      try { code = ((await response.json()) as { error?: { code?: number } })?.error?.code; } catch { /* not json */ }
      safeError('send', new Error('send failed'), { status: response.status, code });
      void alert('send_failed', { status: response.status, code: code ?? null });
      const friendly = friendlyResponse(code ?? null);
      if (friendly) return friendly;
      return NextResponse.json({ error: 'Failed to send message' }, { status: 502 });
    }

    const result = await response.json();

    const sentId = extractSentMessageId(result);
    if (sentId) {
      try { recordMessageSender(sentId, authUser); } catch (e) { safeError('senders', e); }
    }
    const mt = basePayload.type as string;
    storeOutbound(to, sentId, {
      type: mt,
      body: mt === 'text' ? body : null,
      caption: mt !== 'text' ? body || null : null,
      mediaId: basePayload[mt]?.id ?? null,
      mediaPath: savedMedia,
      mediaMime: file?.type || null,
      mediaSize: file?.size ?? null,
      mediaFilename: file?.name ?? null,
      replyTo,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (isWindowError(error)) return NextResponse.json({ error: 'window_closed' }, { status: 409 });
    const friendly = friendlyResponse(graphErrorCode(error));
    if (friendly) return friendly;
    safeError('send', error);
    void alert('send_failed');
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    );
  }
}
