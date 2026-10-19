'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, Download, ImageOff, Loader2, Minus, Plus, RotateCw, X } from 'lucide-react';
import { downloadHref } from '@/components/media-message';
import { cn } from '@/lib/utils';

export type ViewerImage = {
  /** Our authenticated media proxy URL (/api/media/...) or a local blob: preview of an image being sent. */
  src: string;
  alt: string;
  filename?: string | null;
  /** Contact name, or "Enviado por X". */
  sender: string;
  createdAt: string;
};

/** Only our authenticated proxy routes, or local object URLs for images the user is sending right now. */
export function isViewerSafeSrc(src: string): boolean {
  return src.startsWith('/api/media/') || src.startsWith('blob:');
}

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_SCALE = 2.5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('es-CO', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

type Props = {
  images: ViewerImage[];
  index: number | null;
  onIndexChange: (i: number) => void;
  onClose: () => void;
};

export function ImageViewer({ images, index, onIndexChange, onClose }: Props) {
  const open = index !== null && index >= 0 && index < images.length;
  const item = open ? images[index] : null;
  const safe = !!item && isViewerSafeSrc(item.src);

  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [rot, setRot] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dragging, setDragging] = useState(false);
  const [swipeY, setSwipeY] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startX: number; startY: number; tx: number; ty: number; dist: number; scale: number; moved: boolean; touch: boolean } | null>(null);
  const lastTap = useRef(0);
  const scaleRef = useRef(1);
  scaleRef.current = scale;

  const reset = useCallback(() => { setScale(1); setTx(0); setTy(0); setRot(0); setSwipeY(0); }, []);

  // New image: reset transform and show the spinner until it loads.
  useEffect(() => { reset(); setStatus('loading'); }, [item?.src, reset]);

  const zoomTo = useCallback((next: number) => {
    const s = clamp(next, MIN_SCALE, MAX_SCALE);
    setScale(s);
    if (s === 1) { setTx(0); setTy(0); }
  }, []);

  const count = images.length;
  const go = useCallback((delta: number) => {
    if (index === null || count < 2) return;
    const next = index + delta;
    if (next >= 0 && next < count) onIndexChange(next);
  }, [index, count, onIndexChange]);

  // Wheel / trackpad zoom (non-passive so we can stop the page from scrolling).
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !open) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      zoomTo(scaleRef.current * factor);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [open, zoomTo, item?.src]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(scale * 1.25); }
    else if (e.key === '-') { e.preventDefault(); zoomTo(scale / 1.25); }
    else if (e.key === '0') { e.preventDefault(); reset(); }
  };

  const toggleZoom = () => zoomTo(scale > 1 ? 1 : DOUBLE_SCALE);

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button,a')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const dist = pts.length === 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { startX: e.clientX, startY: e.clientY, tx, ty, dist, scale, moved: false, touch: e.pointerType === 'touch' };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length === 2 && g.dist > 0) {
      g.moved = true;
      zoomTo(g.scale * (Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) / g.dist));
      return;
    }
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
    if (scale > 1) {
      setTx(g.tx + dx / scale);
      setTy(g.ty + dy / scale);
    } else if (g.touch && dy > 0) {
      setSwipeY(dy);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) return;
    gesture.current = null;
    setDragging(false);
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (scale <= 1 && g.touch && g.moved) {
      if (dy > 120 && Math.abs(dy) > Math.abs(dx)) { onClose(); return; }
      setSwipeY(0);
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
      return;
    }
    setSwipeY(0);
    if (g.moved) return;
    // Tap / click without movement.
    if (g.touch) {
      const now = Date.now();
      if (now - lastTap.current < 300) { lastTap.current = 0; toggleZoom(); return; }
      lastTap.current = now;
    }
    // Click on the backdrop (not on the image) closes when not zoomed.
    if (scale <= 1 && !(e.target as HTMLElement).closest('img')) onClose();
  };

  const sideways = Math.abs(rot % 180) === 90;
  const btn = 'inline-flex items-center justify-center gap-1 rounded-md h-9 min-w-9 px-2 text-sm text-white hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-brand-text disabled:opacity-40 disabled:pointer-events-none';
  const motion = dragging ? '' : 'motion-safe:transition-transform motion-safe:duration-150';

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/85 motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0"
          style={{ opacity: swipeY ? Math.max(0.3, 1 - swipeY / 400) : undefined }}
        />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col text-white outline-none"
          onKeyDown={onKeyDown}
          aria-describedby={undefined}
        >
          {item && (
            <>
              {/* Top bar */}
              <div className="flex items-center gap-2 px-3 py-2 bg-surface/70 dark:bg-surface/80 backdrop-blur-sm border-b border-white/10">
                <div className="min-w-0 flex-1">
                  <DialogPrimitive.Title className="text-sm font-medium truncate">{item.sender}</DialogPrimitive.Title>
                  <p className="text-xs text-white/70 truncate">
                    {formatWhen(item.createdAt)}
                    {count > 1 && <span aria-live="polite"> · {(index ?? 0) + 1} / {count}</span>}
                  </p>
                </div>
                <button type="button" className={btn} onClick={() => zoomTo(scale / 1.25)} disabled={scale <= MIN_SCALE} aria-label="Alejar">
                  <Minus className="h-4 w-4" aria-hidden="true" />
                </button>
                <span className="w-12 text-center text-xs tabular-nums text-white/80" aria-live="polite" aria-label={`Zoom ${Math.round(scale * 100)} %`}>
                  {Math.round(scale * 100)}%
                </span>
                <button type="button" className={btn} onClick={() => zoomTo(scale * 1.25)} disabled={scale >= MAX_SCALE} aria-label="Acercar">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                </button>
                <button type="button" className={btn} onClick={() => setRot((r) => r + 90)} aria-label="Girar">
                  <RotateCw className="h-4 w-4" aria-hidden="true" /><span className="hidden sm:inline">Girar</span>
                </button>
                {item.src.startsWith('/api/media/') && (
                  <a className={btn} href={downloadHref(item.src, item.filename)} download={item.filename || true} aria-label="Descargar">
                    <Download className="h-4 w-4" aria-hidden="true" /><span className="hidden sm:inline">Descargar</span>
                  </a>
                )}
                <DialogPrimitive.Close className={cn(btn, 'bg-brand hover:bg-brand-hover')} aria-label="Cerrar">
                  <X className="h-4 w-4" aria-hidden="true" /><span className="hidden sm:inline">Cerrar</span>
                </DialogPrimitive.Close>
              </div>

              {/* Stage */}
              <div
                ref={stageRef}
                className={cn('relative flex-1 overflow-hidden flex items-center justify-center select-none touch-none',
                  scale > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in')}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button,a')) toggleZoom(); }}
              >
                {status === 'loading' && safe && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none" role="status">
                    <Loader2 className="h-10 w-10 text-brand-text motion-safe:animate-spin" aria-hidden="true" />
                    <span className="sr-only">Cargando imagen…</span>
                  </div>
                )}
                {(status === 'error' || !safe) && (
                  <div className="flex flex-col items-center gap-2 text-white/80" role="alert">
                    <ImageOff className="h-10 w-10" aria-hidden="true" />
                    <p className="text-sm">No se pudo cargar la imagen.</p>
                  </div>
                )}
                {safe && status !== 'error' && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    key={item.src}
                    src={item.src}
                    alt={item.alt}
                    draggable={false}
                    onLoad={() => setStatus('ready')}
                    onError={() => setStatus('error')}
                    className={cn('object-contain', motion, status === 'loading' && 'opacity-0')}
                    style={{
                      maxWidth: sideways ? 'calc(100dvh - 56px)' : '100%',
                      maxHeight: sideways ? '100vw' : '100%',
                      transform: `translate(0, ${swipeY}px) scale(${scale}) translate(${tx}px, ${ty}px) rotate(${rot}deg)`,
                    }}
                  />
                )}

                {count > 1 && (
                  <>
                    <button type="button" className={cn(btn, 'absolute left-2 top-1/2 -translate-y-1/2 h-12 w-12 rounded-full bg-black/40')}
                      onClick={() => go(-1)} disabled={(index ?? 0) === 0} aria-label="Imagen anterior">
                      <ChevronLeft className="h-6 w-6" aria-hidden="true" />
                    </button>
                    <button type="button" className={cn(btn, 'absolute right-2 top-1/2 -translate-y-1/2 h-12 w-12 rounded-full bg-black/40')}
                      onClick={() => go(1)} disabled={(index ?? 0) >= count - 1} aria-label="Imagen siguiente">
                      <ChevronRight className="h-6 w-6" aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
