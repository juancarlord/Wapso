import { NextResponse } from 'next/server';
import {
  buildKapsoFields,
  type ConversationKapsoExtensions,
  type ConversationRecord
} from '@kapso/whatsapp-cloud-api';
import { whatsappClient, PHONE_NUMBER_ID } from '@/lib/whatsapp-client';

function parseDirection(kapso?: ConversationKapsoExtensions): 'inbound' | 'outbound' {
  if (!kapso) {
    return 'inbound';
  }

  const inboundAt = typeof kapso.lastInboundAt === 'string' ? Date.parse(kapso.lastInboundAt) : Number.NaN;
  const outboundAt = typeof kapso.lastOutboundAt === 'string' ? Date.parse(kapso.lastOutboundAt) : Number.NaN;

  if (Number.isFinite(inboundAt) && Number.isFinite(outboundAt)) {
    return inboundAt >= outboundAt ? 'inbound' : 'outbound';
  }

  if (Number.isFinite(inboundAt)) return 'inbound';
  if (Number.isFinite(outboundAt)) return 'outbound';
  return 'inbound';
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const after = searchParams.get('after'); // cursor for pagination
    const limit = 100; // max allowed by API

    console.log('[API] GET /api/conversations', { status, after, limit });
    const response = await whatsappClient.conversations.list({
      phoneNumberId: PHONE_NUMBER_ID,
      ...(status && { status: status as 'active' | 'ended' }),
      ...(after && { after }), // add cursor if provided
      limit,
      fields: buildKapsoFields([
        'contact_name',
        'messages_count',
        'last_message_type',
        'last_message_text',
        'last_inbound_at',
        'last_outbound_at'
      ])
    });

    // Transform conversations to match frontend expectations
    const transformedData = response.data.map((conversation: ConversationRecord) => {
      const kapso = conversation.kapso;

      const lastMessageText = typeof kapso?.lastMessageText === 'string' ? kapso.lastMessageText : undefined;
      const lastMessageType = typeof kapso?.lastMessageType === 'string' ? kapso.lastMessageType : undefined;

      return {
        id: conversation.id,
        phoneNumber: conversation.phoneNumber ?? '',
        status: conversation.status ?? 'unknown',
        lastActiveAt: typeof conversation.lastActiveAt === 'string' ? conversation.lastActiveAt : undefined,
        phoneNumberId: conversation.phoneNumberId ?? PHONE_NUMBER_ID,
        metadata: conversation.metadata ?? {},
        contactName: typeof kapso?.contactName === 'string' ? kapso.contactName : undefined,
        messagesCount: typeof kapso?.messagesCount === 'number' ? kapso.messagesCount : undefined,
        lastMessage: lastMessageText
          ? {
              content: lastMessageText,
              direction: parseDirection(kapso),
              type: lastMessageType
            }
          : undefined
      };
    });

    console.log(`[API] Fetched ${transformedData.length} conversations`);
    console.log('[API] conversations.list -> items:', response.data?.length, 'paging:', response.paging);

    return NextResponse.json({
      data: transformedData,
      paging: response.paging // includes 'after' cursor for next page
    });
  } catch (error) {
    console.error('Error fetching conversations:', error);
    return NextResponse.json(
      { error: 'Failed to fetch conversations' },
      { status: 500 }
    );
  }
}
