'use client';
// "Horario y fuera de turno" admin card (P-009-KC KC1). Rendered only for admins; the API enforces admin too.
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Settings = { enabled: boolean; timezone: string; open: string; close: string; days: number[]; lang: 'es' | 'en'; afterHoursText: { es: string; en: string } };
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export function ShiftCard() {
  const [s, setS] = useState<Settings | null>(null);
  const [openNow, setOpenNow] = useState<boolean | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/shift').then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) { setS(j.settings); setOpenNow(j.openNow); } });
  }, []);
  if (!s) return null;

  const save = async () => {
    setErr(null); setMsg(null);
    const res = await fetch('/api/admin/shift', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(j?.error || 'Ocurrió un error'); return; }
    setS(j.settings); setOpenNow(j.openNow); setMsg('Horario guardado');
  };
  const toggleDay = (d: number) => setS({ ...s, days: s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d].sort() });

  return (
    <section className="mt-8 rounded-lg border border-line p-4">
      <h2 className="text-lg font-semibold">Horario y fuera de turno</h2>
      <p className="text-sm text-muted-fg">
        Zona horaria {s.timezone}. Ahora: {openNow ? 'en horario' : 'fuera de turno'}. Fuera del horario, cada cliente recibe este mensaje una sola vez por periodo cerrado.
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
        Respuesta automática activada
      </label>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div><Label htmlFor="sh-open">Abre</Label><Input id="sh-open" type="time" value={s.open} onChange={(e) => setS({ ...s, open: e.target.value })} /></div>
        <div><Label htmlFor="sh-close">Cierra</Label><Input id="sh-close" type="time" value={s.close} onChange={(e) => setS({ ...s, close: e.target.value })} /></div>
        <div className="flex gap-1">
          {DAYS.map((d, i) => (
            <button key={d} type="button" onClick={() => toggleDay(i)} aria-pressed={s.days.includes(i)}
              className={`rounded px-2 py-1 text-xs border border-line ${s.days.includes(i) ? 'bg-brand text-white' : ''}`}>{d}</button>
          ))}
        </div>
        <div>
          <Label htmlFor="sh-lang">Idioma enviado</Label>
          <select id="sh-lang" className="block rounded border border-line bg-transparent px-2 py-1 text-sm" value={s.lang} onChange={(e) => setS({ ...s, lang: e.target.value as 'es' | 'en' })}>
            <option value="es">Español</option><option value="en">English</option>
          </select>
        </div>
      </div>
      {(['es', 'en'] as const).map((l) => (
        <div key={l} className="mt-3">
          <Label htmlFor={`sh-${l}`}>{l === 'es' ? 'Español' : 'English'}</Label>
          <textarea id={`sh-${l}`} rows={4} maxLength={1000} className="mt-1 w-full rounded border border-line bg-transparent p-2 text-sm"
            value={s.afterHoursText[l]} onChange={(e) => setS({ ...s, afterHoursText: { ...s.afterHoursText, [l]: e.target.value } })} />
        </div>
      ))}
      <div className="mt-3 flex gap-2">
        <Button type="button" onClick={save}>Guardar</Button>
        <Button type="button" variant="outline" onClick={() => setPreview(s.afterHoursText[s.lang] || s.afterHoursText.es)}>Probar mensaje</Button>
      </div>
      {preview !== null && (
        <div className="mt-3 max-w-md whitespace-pre-wrap rounded-lg bg-surface p-3 text-sm border border-line" aria-label="Vista previa">
          {preview}
          <div className="mt-1 text-xs text-muted-fg">Vista previa: no se envía a nadie.</div>
        </div>
      )}
      {msg && <p className="mt-2 text-sm text-green-600">{msg}</p>}
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </section>
  );
}
