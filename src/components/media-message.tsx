'use client';

import { useState } from 'react';
import { Download, FileSpreadsheet, FileText, File as FileIcon, ImageOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

type Props = {
  /** Our authenticated proxy URL (/api/media/...) or a local blob: URL for optimistic sends. */
  src?: string;
  kind: MediaKind;
  filename?: string | null;
  mimeType?: string | null;
  sizeText?: string | null;
  onOpenImage?: (src: string, alt: string) => void;
};

export function mediaKindFrom(messageType?: string, mime?: string | null): MediaKind {
  if (messageType === 'sticker') return 'sticker';
  if (messageType === 'image' || mime?.startsWith('image/')) return 'image';
  if (messageType === 'video' || mime?.startsWith('video/')) return 'video';
  if (messageType === 'audio' || mime?.startsWith('audio/')) return 'audio';
  return 'document';
}

/** Adds download params to our proxy URL (not to blob: URLs). */
export function downloadHref(src: string, filename?: string | null): string {
  if (!src.startsWith('/api/')) return src;
  const q = new URLSearchParams({ dl: '1' });
  if (filename) q.set('name', filename);
  return `${src}${src.includes('?') ? '&' : '?'}${q}`;
}

function docInfo(filename?: string | null, mime?: string | null) {
  const ext = (filename?.split('.').pop() || '').toLowerCase();
  const m = mime || '';
  if (ext === 'pdf' || m === 'application/pdf') return { label: 'PDF', Icon: FileText, color: 'text-red-600 dark:text-red-400' };
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext) || m.includes('word')) return { label: 'Word', Icon: FileText, color: 'text-blue-700 dark:text-blue-300' };
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext) || m.includes('sheet') || m.includes('excel') || m === 'text/csv') {
    return { label: ext === 'csv' ? 'CSV' : 'Excel', Icon: FileSpreadsheet, color: 'text-green-700 dark:text-green-400' };
  }
  return { label: ext ? ext.toUpperCase().slice(0, 5) : 'Archivo', Icon: FileIcon, color: 'text-muted-fg' };
}

export function MediaMessage({ src, kind, filename, mimeType, sizeText, onOpenImage }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-panel px-3 py-2 text-sm text-muted-fg w-60" role="note">
        <ImageOff className="h-4 w-4" aria-hidden="true" />
        Archivo no disponible
      </div>
    );
  }

  if (kind === 'image' || kind === 'sticker') {
    const alt = `${kind === 'sticker' ? 'Sticker' : 'Imagen'}${filename ? ` ${filename}` : ''}`;
    const box = kind === 'sticker' ? 'w-32 h-32' : 'w-[280px] max-w-full';
    return (
      <button
        type="button"
        className={cn('relative block rounded-lg overflow-hidden focus-visible:outline-2', box, kind === 'image' && !loaded && 'h-48')}
        onClick={() => kind === 'image' && onOpenImage?.(src, alt)}
        aria-label={kind === 'image' ? `Abrir ${alt}` : alt}
        disabled={kind === 'sticker'}
      >
        {!loaded && <Skeleton className="absolute inset-0 w-full h-full" />}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className={cn(
            'block w-full h-auto object-cover',
            kind === 'image' ? 'max-h-[360px] rounded-lg' : 'object-contain',
            !loaded && 'opacity-0'
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      </button>
    );
  }

  if (kind === 'video') {
    return (
      <video src={src} controls preload="metadata" className="rounded-lg w-[280px] max-w-full max-h-[360px] bg-black"
        aria-label={`Video${filename ? ` ${filename}` : ''}`} onError={() => setFailed(true)} />
    );
  }

  if (kind === 'audio') {
    return <audio src={src} controls preload="metadata" className="w-64 max-w-full" aria-label={`Audio${filename ? ` ${filename}` : ''}`} onError={() => setFailed(true)} />;
  }

  const { label, Icon, color } = docInfo(filename, mimeType);
  const name = filename || 'Documento';
  const isPdf = label === 'PDF';
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-surface/70 p-2.5 w-[280px] max-w-full">
      <Icon className={cn('h-9 w-9 flex-shrink-0', color)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {isPdf ? (
          <a href={src} target="_blank" rel="noopener noreferrer" title={name}
            className="block truncate text-sm font-medium text-fg hover:underline">
            {name}
          </a>
        ) : (
          <p className="truncate text-sm font-medium text-fg" title={name}>{name}</p>
        )}
        <p className="text-xs text-muted-fg">{[label, sizeText].filter(Boolean).join(' · ')}</p>
      </div>
      <Button asChild size="sm" variant="ghost" className="text-brand-text hover:bg-line/30 px-2" aria-label={`Descargar ${name}`}>
        <a href={downloadHref(src, filename)} download={filename || true}>
          <Download className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only sm:not-sr-only sm:ml-1">Descargar</span>
        </a>
      </Button>
    </div>
  );
}
