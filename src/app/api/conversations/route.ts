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

    if (response.data && response.data.length > 0) {
      console.log('[API] First conversation data:', JSON.stringify(response.data[0], null, 2));
    }

    // Transform conversations to match frontend expectations
    const transformedData = response.data.map((conversation: ConversationRecord) => {
      const kapso = conversation.kapso;

      const lastMessageText = typeof kapso?.lastMessageText === 'string' ? kapso.lastMessageText : undefined;
      const lastMessageType = typeof kapso?.lastMessageType === 'string' ? kapso.lastMessageType : undefined;

      return {
        id: conversation.id,
        phoneNumber: conversation.phoneNumber ?? '',
        bsuid: conversation.businessScopedUserId ?? '',
        username: conversation.username ?? null,
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

    // Merge conversations that share the same contactName or phoneNumber
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finalData: any[] = [];
    transformedData.forEach(conv => {
      const existing = finalData.find(e => 
        (e.phoneNumber && conv.phoneNumber && e.phoneNumber === conv.phoneNumber) ||
        (e.contactName && conv.contactName && e.contactName === conv.contactName)
      );

      if (existing) {
        // Merge the IDs by comma separating them
        if (!existing.id.split(',').includes(conv.id)) {
          existing.id = `${existing.id},${conv.id}`;
        }
        if (!existing.bsuid) existing.bsuid = conv.bsuid;
        if (!existing.username) existing.username = conv.username;
        if (!existing.phoneNumber) existing.phoneNumber = conv.phoneNumber;
        if (!existing.contactName) existing.contactName = conv.contactName;
        
        if (conv.lastActiveAt) {
          if (!existing.lastActiveAt || new Date(conv.lastActiveAt) > new Date(existing.lastActiveAt)) {
            existing.lastActiveAt = conv.lastActiveAt;
            existing.lastMessage = conv.lastMessage;
          }
        }
      } else {
        finalData.push({ ...conv });
      }
    });

    // Sort final merged data by lastActiveAt descending
    finalData.sort((a, b) => {
      const timeA = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
      const timeB = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
      return timeB - timeA;
    });

    console.log(`[API] Fetched ${finalData.length} conversations (after merge)`);
    console.log('[API] conversations.list -> items:', response.data?.length, 'paging:', response.paging);

    return NextResponse.json({
      data: finalData,
      rawData: response.data,
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
