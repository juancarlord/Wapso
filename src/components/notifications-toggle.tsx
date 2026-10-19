'use client';

import { useEffect, useState } from 'react';
import { Bell, BellOff, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';

const cls = 'text-muted-fg hover:bg-line/30';

export function isSoundMuted(): boolean {
  try { return localStorage.getItem('notif-muted') === '1'; } catch { return false; }
}

/** Short, quiet beep via Web Audio (no asset needed). */
export function playPing() {
  if (isSoundMuted()) return;
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.25);
    o.onended = () => ctx.close();
  } catch { /* ignore */ }
}

export function NotificationsToggle() {
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('default');
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    setPerm(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
    setMuted(isSoundMuted());
  }, []);

  if (perm === 'unsupported') return null;

  if (perm !== 'granted') {
    return (
      <Button variant="ghost" size="icon" className={cls}
        title={perm === 'denied' ? 'Notificaciones bloqueadas en el navegador' : 'Activar notificaciones'}
        aria-label={perm === 'denied' ? 'Notificaciones bloqueadas en el navegador' : 'Activar notificaciones'}
        disabled={perm === 'denied'}
        onClick={async () => setPerm(await Notification.requestPermission())}>
        {perm === 'denied' ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
      </Button>
    );
  }

  return (
    <Button variant="ghost" size="icon" className={cls}
      title={muted ? 'Sonido desactivado (activar)' : 'Sonido activado (silenciar)'}
      aria-label={muted ? 'Activar sonido de notificaciones' : 'Silenciar sonido de notificaciones'}
      aria-pressed={muted}
      onClick={() => { const m = !muted; setMuted(m); localStorage.setItem('notif-muted', m ? '1' : '0'); }}>
      {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
    </Button>
  );
}
