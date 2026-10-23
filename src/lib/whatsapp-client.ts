import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';
import { inboxSource, graphVersion } from '@/lib/config';

const TIMEOUT_MS = 15_000;
const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS) });

/** Kapso proxy client: reads while INBOX_SOURCE=kapso, the export script and rollback. */
export const kapsoClient = new WhatsAppClient({
  baseUrl: 'https://api.kapso.ai/meta/whatsapp',
  kapsoApiKey: process.env.KAPSO_API_KEY!,
  graphVersion: 'v24.0',
  fetch: timedFetch,
});

/** Direct Meta Graph client (sends, media) for INBOX_SOURCE=local. */
export const graphClient = new WhatsAppClient({
  baseUrl: 'https://graph.facebook.com',
  accessToken: process.env.META_ACCESS_TOKEN,
  graphVersion: graphVersion(),
  fetch: timedFetch,
});

export const IS_LOCAL = inboxSource() === 'local';
/** The client every route uses: Graph when INBOX_SOURCE=local, Kapso otherwise. */
export const whatsappClient = IS_LOCAL ? graphClient : kapsoClient;

export const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID!;
