import { NextResponse } from 'next/server';
import { whatsappClient, PHONE_NUMBER_ID } from '@/lib/whatsapp-client';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const to = formData.get('to') as string;
    const body = formData.get('body') as string;
    const file = formData.get('file') as File | null;

    if (!to) {
      return NextResponse.json(
        { error: 'Missing required field: to' },
        { status: 400 }
      );
    }

    const isBsuid = to.includes('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const basePayload: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...(isBsuid ? { recipient: to } : { to })
    };

    // Send media message
    if (file) {
      const fileType = file.type.split('/')[0]; // image, video, audio, application
      const mediaType = fileType === 'application' ? 'document' : fileType;

      // Upload media first
      const uploadResult = await whatsappClient.media.upload({
        phoneNumberId: PHONE_NUMBER_ID,
        type: mediaType as 'image' | 'video' | 'audio' | 'document',
        file: file,
        fileName: file.name
      });

      basePayload.type = mediaType;
      basePayload[mediaType] = { id: uploadResult.id };
      if (body) {
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
      const errorText = await response.text();
      console.error('Failed to send message via Kapso API:', errorText);
      throw new Error(`Failed to send message: ${errorText}`);
    }

    const result = await response.json();

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error sending message:', error);
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    );
  }
}
