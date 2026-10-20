'use client';

import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

export type RowMenuItem = { label: string; onSelect: () => void; danger?: boolean; separatorBefore?: boolean };

/** '⋯' button with a small dropdown. Fixed-positioned so table overflow never clips it. Closes on outside click, Esc, scroll. */
export function RowMenu({ items, label = 'Acciones' }: { items: RowMenuItem[]; label?: string }) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); btnRef.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    menuRef.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  if (items.length === 0) return null;
  const toggle = () => {
    if (pos) return setPos(null);
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        onClick={toggle}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-fg hover:bg-line/30 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {pos && (
        <div
          ref={menuRef}
          role="menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
          className="z-50 min-w-[200px] rounded-md border border-line bg-surface py-1 text-sm text-fg shadow-lg"
        >
          {items.map((it) => (
            <div key={it.label}>
              {it.separatorBefore && <div role="separator" className="my-1 h-px bg-line" />}
              <button
                type="button"
                role="menuitem"
                onClick={() => { setPos(null); it.onSelect(); }}
                className={cn(
                  'block w-full px-3 py-1.5 text-left hover:bg-panel focus-visible:bg-panel focus-visible:outline-none',
                  it.danger && 'text-red-600 dark:text-red-400'
                )}
              >
                {it.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
