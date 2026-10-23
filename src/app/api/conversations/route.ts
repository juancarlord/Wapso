import { requireUser } from '@/lib/auth';
import { getReadMarks } from '@/lib/db';
import { contactKey, emptyAssignment, getAllAssignments, reopenIfNewInbound } from '@/lib/assignments';
import { mediaPreviewText } from '@/lib/media-text';
import { NextResponse } from 'next/server';
import {
  buildKapsoFields,
  type ConversationKapsoExtensions,
  type ConversationRecord
} from '@kapso/whatsapp-cloud-api';
import { whatsappClient, PHONE_NUMBER_ID, IS_LOCAL } from '@/lib/whatsapp-client';
import { getDb } from '@/lib/db';
import { getSeq } from '@/lib/inbox-store';
import { listLocalConversations } from '@/lib/inbox-read';
import { safeError } from '@/lib/log';

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
  const authUserOrRes = await requireUser(request);
  if (authUserOrRes instanceof NextResponse) return authUserOrRes;
  const authUser = authUserOrRes;

  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const after = searchParams.get('after'); // cursor for pagination
    const limit = 100; // max allowed by API

    if (IS_LOCAL) {
      const db = getDb();
      // Cursor = message change seq + latest assignment change, so another agent's take/resolve also refreshes.
      getAllAssignments();
      const asg = (db.prepare('SELECT COALESCE(MAX(updated_at),0) AS t FROM conversation_assignments').get() as { t: number }).t;
      const seq = `${getSeq(db)}.${asg}`;
      // Nothing changed since the client's cursor: 204 (cheap 3 s polling, D1).
      if (searchParams.get('since') === seq) return new NextResponse(null, { status: 204 });
      return finish(listLocalConversations(db, PHONE_NUMBER_ID, limit), {}, seq);
    }
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

      const lastMessageText = typeof kapso?.lastMessageText === 'string' ? mediaPreviewText(kapso.lastMessageText) || undefined : undefined;
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
        lastInboundAt: typeof kapso?.lastInboundAt === 'string' ? kapso.lastInboundAt : undefined,
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

    return finish(transformedData, response.paging);
  } catch (error) {
    safeError('conversations', error);
    return NextResponse.json({ error: 'Failed to fetch conversations' }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function finish(transformedData: any[], paging: unknown, seq?: string) {
    // Per-user unread: a member conversation is unread if its latest inbound is newer than this user's read mark.
    const readMarks = getReadMarks(authUser.id);
    const isUnread = (c: { id: string; lastInboundAt?: string; lastActiveAt?: string; lastMessage?: { direction: string } }) => {
      const a = c.lastInboundAt ? Date.parse(c.lastInboundAt) : NaN;
      const b = c.lastMessage?.direction === 'inbound' && c.lastActiveAt ? Date.parse(c.lastActiveAt) : NaN;
      const t = Math.max(Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0);
      return t > 0 && t > (readMarks.get(c.id) ?? 0);
    };
    const withUnread = transformedData.map((c) => ({ ...c, unread: isUnread(c) }));

    // Merge conversations that share the same contactName or phoneNumber
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finalData: any[] = [];
    withUnread.forEach(conv => {
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
        existing.unread = existing.unread || conv.unread;
        if (conv.lastInboundAt && (!existing.lastInboundAt || Date.parse(conv.lastInboundAt) > Date.parse(existing.lastInboundAt))) {
          existing.lastInboundAt = conv.lastInboundAt;
        }
        
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

    // Attach per-contact assignment; auto-reopen resolved chats that got a new inbound message (same agent kept).
    let assignments = new Map<string, ReturnType<typeof emptyAssignment>>();
    try {
      assignments = getAllAssignments();
    } catch (e) {
      safeError('assignments', e);
    }
    for (const c of finalData) {
      const key = contactKey(c);
      let a = assignments.get(key) ?? emptyAssignment(key);
      const ia = c.lastInboundAt ? Date.parse(c.lastInboundAt) : NaN;
      const ib = c.lastMessage?.direction === 'inbound' && c.lastActiveAt ? Date.parse(c.lastActiveAt) : NaN;
      const latestInbound = Math.max(Number.isFinite(ia) ? ia : 0, Number.isFinite(ib) ? ib : 0);
      let reopened = false;
      try { reopened = reopenIfNewInbound(a, latestInbound); } catch (e) { safeError('auto-reopen', e); }
      if (reopened) a = { ...a, status: 'open', resolvedAt: null, resolvedByName: null, resolvedByUserId: null };
      c.assignmentKey = key;
      c.assignedUserId = a.assignedUserId;
      c.assignedName = a.assignedName;
      c.chatStatus = a.status;
    }


    return NextResponse.json({
      data: finalData,
      me: authUser.id,
      paging, // includes 'after' cursor for next page (Kapso)
      ...(seq !== undefined && { seq }),
    });
  }
}
