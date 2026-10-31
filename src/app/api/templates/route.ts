import { requireUser } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { whatsappClient } from '@/lib/whatsapp-client';
import { safeError } from '@/lib/log';

export async function GET(request: Request) {
  const authUser = await requireUser(request);
  if (authUser instanceof NextResponse) return authUser;

  try {
    const wabaId = process.env.WABA_ID;

    if (!wabaId) {
      return NextResponse.json(
        { error: 'WABA_ID not configured' },
        { status: 500 }
      );
    }

    const response = await whatsappClient.templates.list({
      businessAccountId: wabaId,
      limit: 100
    });

    return NextResponse.json({
      data: response.data,
      paging: response.paging
    });
  } catch (error) {
    safeError('templates', error); // never log the raw error object (may carry tokens/URLs)
    return NextResponse.json(
      { error: 'Failed to fetch templates' },
      { status: 500 }
    );
  }
}
