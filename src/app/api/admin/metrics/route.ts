import { NextResponse } from 'next/server';
import { requireManager } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { contactKey, getAllAssignments } from '@/lib/assignments';
import { whatsappClient, PHONE_NUMBER_ID, IS_LOCAL } from '@/lib/whatsapp-client';
import { safeError } from '@/lib/log';
import { alert } from '@/lib/alert';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BOGOTA_OFFSET_MS = 5 * 3600_000; // America/Bogota is UTC-5 all year (no DST)
const DAY_MS = 86_400_000;
const PERIODS = { hoy: 1, '7d': 7, '30d': 30 } as const;
type Period = keyof typeof PERIODS;

/** Start (epoch ms) of the period: Bogotá midnight today, minus (days - 1) days. */
function periodStart(days: number, now = Date.now()): number {
  const todayStart = Math.floor((now - BOGOTA_OFFSET_MS) / DAY_MS) * DAY_MS + BOGOTA_OFFSET_MS;
  return todayStart - (days - 1) * DAY_MS;
}

export async function GET(request: Request) {
  const me = await requireManager(request);
  if (me instanceof NextResponse) return me;
  const p = new URL(request.url).searchParams.get('period') as Period | null;
  const period: Period = p && Object.hasOwn(PERIODS, p) ? p : '7d';
  const start = periodStart(PERIODS[period]);
  const db = getDb();
  getAllAssignments(); // ensures the assignments table exists on older DBs

  // Per-agent: messages sent (message_senders.created_at is UTC 'YYYY-MM-DD HH:MM:SS').
  const sent = db.prepare(
    `SELECT ms.user_id AS id,
            COALESCE(NULLIF(u.name,''), NULLIF(u.username,''), NULLIF(MAX(ms.sender_name),''), 'Usuario eliminado') AS name,
            COUNT(*) AS n
     FROM message_senders ms LEFT JOIN users u ON u.id = ms.user_id
     WHERE CAST(strftime('%s', ms.created_at) AS INTEGER) * 1000 >= ?
     GROUP BY ms.user_id`
  ).all(start) as { id: number; name: string; n: number }[];

  // Per-agent: chats resolved in period + average assigned_at -> resolved_at.
  const resolved = db.prepare(
    `SELECT a.resolved_by_user_id AS id,
            COALESCE(NULLIF(u.name,''), NULLIF(u.username,''), NULLIF(MAX(a.resolved_by_name),''), 'Usuario eliminado') AS name,
            COUNT(*) AS n,
            AVG(CASE WHEN a.assigned_at IS NOT NULL AND a.assigned_at <= a.resolved_at THEN a.resolved_at - a.assigned_at END) AS avg_ms
     FROM conversation_assignments a LEFT JOIN users u ON u.id = a.resolved_by_user_id
     WHERE a.status = 'resolved' AND a.resolved_at >= ? AND a.resolved_by_user_id IS NOT NULL
     GROUP BY a.resolved_by_user_id`
  ).all(start) as { id: number; name: string; n: number; avg_ms: number | null }[];

  const agents = new Map<number, { id: number; name: string; sent: number; resolved: number; avgResolutionMs: number | null }>();
  for (const r of sent) agents.set(r.id, { id: r.id, name: r.name, sent: Number(r.n), resolved: 0, avgResolutionMs: null });
  for (const r of resolved) {
    const a = agents.get(r.id) ?? { id: r.id, name: r.name, sent: 0, resolved: 0, avgResolutionMs: null };
    a.resolved = Number(r.n);
    a.avgResolutionMs = r.avg_ms == null ? null : Math.round(Number(r.avg_ms));
    agents.set(r.id, a);
  }

  // Busiest hours (Bogotá) of messages sent in the period.
  const hourRows = db.prepare(
    `SELECT CAST(strftime('%H', ms.created_at, '-5 hours') AS INTEGER) AS h, COUNT(*) AS n
     FROM message_senders ms
     WHERE CAST(strftime('%s', ms.created_at) AS INTEGER) * 1000 >= ?
     GROUP BY h`
  ).all(start) as { h: number; n: number }[];
  const hours = Array.from({ length: 24 }, () => 0);
  for (const r of hourRows) if (r.h >= 0 && r.h < 24) hours[r.h] = Number(r.n);

  const resolvedInPeriod = resolved.reduce((s, r) => s + Number(r.n), 0);

  // Current open / unassigned: one Kapso page (latest 100 conversations, same source as the list) joined with our table.
  let open: number | null = null;
  let unassigned: number | null = null;
  const countOpen = (keys: Iterable<string>) => {
    const asg = getAllAssignments();
    open = 0; unassigned = 0;
    for (const k of keys) {
      const a = asg.get(k);
      if (a?.status === 'resolved') continue;
      open++;
      if (!a || a.assignedUserId == null) unassigned++;
    }
  };
  if (IS_LOCAL) {
    // Our own store: every conversation, no external call (K8).
    const rows = db.prepare('SELECT contact_key AS k FROM conversations').all() as { k: string }[];
    countOpen(new Set(rows.map((r) => r.k)));
  } else {
    try {
      const res = await Promise.race([
        whatsappClient.conversations.list({ phoneNumberId: PHONE_NUMBER_ID, limit: 100 }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('metrics upstream timeout')), 10_000)),
      ]);
      countOpen(new Set(res.data.map((c) => contactKey({ id: c.id, phoneNumber: c.phoneNumber ?? '', username: typeof c.username === 'string' ? c.username : null }))));
    } catch (e) {
      open = null; unassigned = null;
      safeError('metrics', e); // name/message/status only, never headers or the API key
      void alert('metrics_upstream');
    }
  }

  return NextResponse.json({
    period,
    start,
    cards: { open, unassigned, resolvedInPeriod },
    agents: [...agents.values()].sort((a, b) => b.sent + b.resolved - (a.sent + a.resolved)),
    hours,
  });
}
