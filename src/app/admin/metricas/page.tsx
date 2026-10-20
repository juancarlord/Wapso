'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Period = 'hoy' | '7d' | '30d';
const PERIODS: { id: Period; label: string }[] = [
  { id: 'hoy', label: 'Hoy' },
  { id: '7d', label: '7 días' },
  { id: '30d', label: '30 días' },
];
type Agent = { id: number; name: string; sent: number; resolved: number; avgResolutionMs: number | null };
type Data = { cards: { open: number | null; unassigned: number | null; resolvedInPeriod: number }; agents: Agent[]; hours: number[] };

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

function Card({ label, value, hint }: { label: string; value: number | null | undefined; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-sm text-muted-fg">{label}</p>
      <p className="mt-1 text-3xl font-semibold text-brand-text">{value ?? '—'}</p>
      {hint && <p className="mt-1 text-xs text-muted-fg">{hint}</p>}
    </div>
  );
}

export default function MetricsPage() {
  const [period, setPeriod] = useState<Period>('7d');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    fetch(`/api/admin/metrics?period=${period}`)
      .then(async (r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((j) => { if (!cancelled) setData(j); })
      .catch(() => { if (!cancelled) setError('No se pudieron cargar las métricas'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period]);

  const hours = data?.hours ?? Array.from({ length: 24 }, () => 0);
  const maxHour = Math.max(1, ...hours);

  return (
    <div className="min-h-screen bg-panel p-4 md:p-8 text-fg">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost" size="icon" aria-label="Volver"><Link href="/"><ArrowLeft className="h-4 w-4" /></Link></Button>
          <h1 className="text-xl font-semibold">Métricas</h1>
          <div role="tablist" aria-label="Periodo" className="ml-auto flex gap-1 rounded-lg border border-line bg-surface p-1">
            {PERIODS.map((p) => (
              <button key={p.id} type="button" role="tab" aria-selected={period === p.id} onClick={() => setPeriod(p.id)}
                className={cn('rounded-md px-3 py-1 text-sm font-medium transition-colors', period === p.id ? 'bg-brand text-white' : 'text-muted-fg hover:bg-line/30')}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className={cn('grid gap-3 sm:grid-cols-3', loading && 'opacity-60')}>
          <Card label="Chats abiertos" value={data?.cards.open} hint="Ahora, últimas 100 conversaciones" />
          <Card label="Sin asignar" value={data?.cards.unassigned} hint="Ahora, últimas 100 conversaciones" />
          <Card label="Resueltos en el periodo" value={data?.cards.resolvedInPeriod} />
        </div>

        <div className="rounded-lg border border-line bg-surface overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-fg border-b border-line">
              <tr>
                <th className="px-3 py-2.5">Agente</th>
                <th className="px-3 py-2.5 text-right">Mensajes enviados</th>
                <th className="px-3 py-2.5 text-right">Chats resueltos</th>
                <th className="px-3 py-2.5 text-right">Tiempo promedio de resolución</th>
              </tr>
            </thead>
            <tbody>
              {(data?.agents ?? []).length === 0 ? (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-fg">{loading ? 'Cargando…' : 'Sin actividad en este periodo'}</td></tr>
              ) : data!.agents.map((a) => (
                <tr key={a.id} className="border-b border-line-soft last:border-0">
                  <td className="px-3 py-2.5 font-medium">{a.name}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{a.sent}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{a.resolved}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtDuration(a.avgResolutionMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border border-line bg-surface p-4">
          <h2 className="text-sm font-medium">Horas con más mensajes enviados</h2>
          <div className="mt-4 flex h-40 items-end gap-[3px]" role="img" aria-label="Mensajes enviados por hora del día (hora de Bogotá)">
            {hours.map((n, h) => (
              <div key={h} className="flex flex-1 flex-col items-center justify-end h-full" title={`${h}:00 · ${n} mensajes`}>
                <div className="w-full rounded-t bg-brand" style={{ height: `${(n / maxHour) * 100}%`, minHeight: n > 0 ? 2 : 0 }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex gap-[3px] text-[10px] text-muted-fg">
            {hours.map((_, h) => <span key={h} className="flex-1 text-center">{h % 3 === 0 ? h : ''}</span>)}
          </div>
          <p className="mt-1 text-xs text-muted-fg">Hora de Bogotá</p>
        </div>

        <p className="text-xs text-muted-fg">Los datos se registran desde el 19/10/2026. El tiempo de primera respuesta llegará en una próxima versión.</p>
      </div>
    </div>
  );
}
