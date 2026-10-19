import { requireUser } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { whatsappClient, PHONE_NUMBER_ID } from '@/lib/whatsapp-client';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  const authUser = await requireUser(request);
  if (authUser instanceof NextResponse) return authUser;

  const { mediaId } = await params;
  try {
    // Get metadata for mime type
    const metadata = await whatsappClient.media.get({
      mediaId,
      phoneNumberId: PHONE_NUMBER_ID
    });

    const buffer = await whatsappClient.media.download({
      mediaId,
      phoneNumberId: PHONE_NUMBER_ID,
      auth: 'never' // Force no auth headers for CDN
    });

    // If buffer is a Response, return it directly
    if (buffer instanceof Response) {
      return buffer;
    }

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': metadata.mimeType || 'application/octet-stream',
        'Cache-Control': 'private, no-store'
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to fetch media',
        details: error instanceof Error ? error.message : 'Unknown error',
        mediaId
      },
      { status: 500, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
}
