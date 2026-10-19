// Parses Kapso's auto-generated media text, e.g.
// "Image attached (image_1.jpeg) [Size: 162.6 KB | Type: image/jpeg] URL: https://app.kapso.ai/..."
export type MediaKind = 'image' | 'document' | 'video' | 'audio' | 'sticker';

export type ParsedMediaText = {
  kind?: MediaKind;
  filename?: string;
  sizeText?: string;
  mimeType?: string;
  /** Whatever is left after removing the auto text (a real caption, if any). */
  rest: string;
};

// Linear-time pieces: bounded, negated classes only (no adjacent lazy quantifiers). Input is also capped.
const HEAD_RE = /(Image|Document|Video|Audio|Sticker|File) attached/i;
const NAME_RE = /^\s{0,5}\(([^\n]{1,200}?)\)(?=\s{0,5}(?:\[Size:|URL:|$|\n))/;
const META_RE = /^\s{0,5}\[\s{0,5}Size:\s{0,5}([^|\]\n]{0,40})(?:\|\s{0,5}Type:\s{0,5}([^\]\n]{0,100}))?\]/;
const URL_RE = /^\s{0,5}URL:\s{0,5}\S{0,2000}/;
const ANY_URL_RE = /URL:[ \t]{0,5}https?:\/\/\S{0,2000}/gi;
const MAX_SCAN = 300;

export function parseMediaAutoText(text: string | null | undefined): ParsedMediaText | null {
  if (!text) return null;
  const head = HEAD_RE.exec(text.slice(0, MAX_SCAN));
  if (!head) return null;
  let pos = head.index + head[0].length;
  const take = (re: RegExp) => {
    const m = re.exec(text.slice(pos, pos + 2400));
    if (m) pos += m[0].length;
    return m;
  };
  const name = take(NAME_RE);
  const meta = take(META_RE);
  take(URL_RE);
  const kindWord = head[1].toLowerCase();
  const kind = (kindWord === 'file' ? 'document' : kindWord) as MediaKind;
  const rest = (text.slice(0, head.index) + text.slice(pos)).replace(ANY_URL_RE, '').trim();
  return {
    kind,
    filename: name?.[1]?.trim() || undefined,
    sizeText: meta?.[1]?.trim() || undefined,
    mimeType: meta?.[2]?.trim() || undefined,
    rest,
  };
}

/** Removes auto text and any stray "URL: https://..." so raw storage links never reach the UI. */
export function cleanMediaText(text: string | null | undefined): string {
  if (!text) return '';
  const p = parseMediaAutoText(text);
  return (p ? p.rest : text).replace(ANY_URL_RE, '').trim();
}

const KIND_LABEL: Record<MediaKind, string> = {
  image: '📷 Imagen',
  document: '📄 Documento',
  video: '🎬 Video',
  audio: '🎤 Audio',
  sticker: 'Sticker',
};

/** Short preview for conversation lists: caption if any, else a label like "📄 Documento". */
export function mediaPreviewText(text: string | null | undefined): string {
  if (!text) return '';
  const p = parseMediaAutoText(text);
  if (!p) return text.replace(ANY_URL_RE, '').trim();
  return p.rest || (p.kind ? KIND_LABEL[p.kind] : 'Archivo');
}

export function formatBytes(n?: number): string | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
