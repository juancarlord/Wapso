'use client';

import { useCallback, useEffect, useState } from 'react';
import { Sparkles, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { RELEASES, LATEST_RELEASE_ID } from '@/lib/releases';
import { cn } from '@/lib/utils';

/** 'Novedades': opens once per user for each new release; the header button reopens it. */
export function WhatsNew() {
  const [open, setOpen] = useState(false);
  const [showOlder, setShowOlder] = useState(false);

  useEffect(() => {
    fetch('/api/releases/seen')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j?.unseen) setOpen(true); })
      .catch(() => {});
  }, []);

  const markSeen = useCallback(() => {
    setOpen(false);
    if (!LATEST_RELEASE_ID) return;
    fetch('/api/releases/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: LATEST_RELEASE_ID }),
    }).catch(() => {});
  }, []);

  const [latest, ...older] = RELEASES;
  if (!latest) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        className="text-muted-fg hover:bg-line/30"
        title="Novedades"
        aria-label="Novedades"
      >
        <Sparkles className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : markSeen())}>
        <DialogContent className="bg-surface text-fg border-line max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <div className="flex flex-col items-center text-center gap-2 pt-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="Mundo Radiológico" className="h-16 w-auto" />
            <DialogTitle className="text-lg font-semibold text-fg">{latest.title}</DialogTitle>
            {latest.subtitle && <DialogDescription className="text-sm text-brand-text font-medium">{latest.subtitle}</DialogDescription>}
          </div>
          <ul className="mt-2 space-y-2 text-sm">
            {latest.items.map((it) => (
              <li key={it} className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-brand flex-shrink-0" aria-hidden="true" />
                <span>{it}</span>
              </li>
            ))}
          </ul>
          {older.length > 0 && (
            <div className="mt-2">
              <button type="button" onClick={() => setShowOlder((v) => !v)} className="flex items-center gap-1 text-xs text-muted-fg hover:text-fg">
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showOlder && 'rotate-180')} />
                Ver anteriores
              </button>
              {showOlder && older.map((r) => (
                <div key={r.id} className="mt-3 border-t border-line pt-3">
                  <p className="text-sm font-medium">{r.title} <span className="text-xs text-muted-fg">({r.id})</span></p>
                  <ul className="mt-1 list-disc pl-5 text-sm text-muted-fg space-y-1">
                    {r.items.map((it) => <li key={it}>{it}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 flex justify-end">
            <Button onClick={markSeen} className="bg-brand hover:bg-brand-hover text-white">Entendido</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
