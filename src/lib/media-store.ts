// Media to disk (P-009 K5/D4). Downloads from Meta Graph into MEDIA_DIR/<sha256>.<ext>.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MEDIA_HOSTS = ['fbsbx.com', 'whatsapp.net'];

export function mediaDir(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(env.MEDIA_DIR || path.join(env.DATA_DIR || './data', 'media'));
}

export function isMetaMediaHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return MEDIA_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
  } catch { return false; }
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'application/pdf': 'pdf',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'text/plain': 'txt',
};
export function extFor(mime: string | null | undefined): string {
  const base = (mime || '').split(';')[0].trim().toLowerCase();
  return EXT[base] ?? 'bin';
}

/** Resolve a stored relative name inside MEDIA_DIR; null on traversal or odd names. */
export function resolveMediaPath(dir: string, rel: string | null | undefined): string | null {
  if (!rel || !/^[a-f0-9]{64}\.[a-z0-9]{1,5}$/.test(rel)) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, rel);
  return full.startsWith(root + path.sep) ? full : null;
}

/** Store bytes by content hash (dedupe). Returns the relative file name. */
export function storeBytes(dir: string, bytes: Uint8Array, mime: string | null): string {
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true, mode: 0o700 });
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const rel = `${hash}.${extFor(mime)}`;
  const final = path.join(dir, rel);
  if (!fs.existsSync(final)) {
    const tmp = path.join(dir, 'tmp', `${hash}.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, final);
  }
  return rel;
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > cap) throw new Error('media too large');
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { await reader.cancel(); throw new Error('media too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Two-step Graph download: GET /{media_id} -> {url}, then GET url with the same bearer, no redirects. */
export async function downloadFromGraph(mediaId: string, opts: { token: string; version: string; fetchImpl?: typeof fetch }): Promise<{ bytes: Uint8Array; mime: string | null }> {
  const f = opts.fetchImpl ?? fetch;
  const auth = { Authorization: `Bearer ${opts.token}` };
  const meta = await f(`https://graph.facebook.com/${opts.version}/${encodeURIComponent(mediaId)}`, { headers: auth, signal: AbortSignal.timeout(15_000) });
  if (!meta.ok) throw Object.assign(new Error('graph media lookup failed'), { status: meta.status });
  const j = (await meta.json()) as { url?: string; mime_type?: string };
  if (!j.url || !isMetaMediaHost(j.url)) throw new Error('media host not allowed');
  const res = await f(j.url, { headers: auth, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (!res.ok || !res.body) throw Object.assign(new Error('media download failed'), { status: res.status });
  return { bytes: await readCapped(res, MAX_MEDIA_BYTES), mime: j.mime_type ?? res.headers.get('content-type') };
}

// In-process queue: concurrency 2, 3 attempts with backoff. Lost on redeploy -> requeuePending() on boot.
type Job = { waMessageId: string; mediaId: string };
const g = globalThis as unknown as { __mediaQ?: { q: Job[]; running: number; queued: Set<string> } };
const Q = (g.__mediaQ ??= { q: [], running: 0, queued: new Set() });

export function enqueueMedia(db: DatabaseSync, job: Job, onFail: (j: Job) => void) {
  if (Q.queued.has(job.waMessageId)) return;
  Q.queued.add(job.waMessageId); Q.q.push(job);
  setImmediate(() => pump(db, onFail));
}
function pump(db: DatabaseSync, onFail: (j: Job) => void) {
  while (Q.running < 2 && Q.q.length) {
    const job = Q.q.shift()!; Q.running++;
    void run(db, job).catch(() => onFail(job)).finally(() => { Q.running--; Q.queued.delete(job.waMessageId); pump(db, onFail); });
  }
}
async function run(db: DatabaseSync, job: Job) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('no token');
  let err: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const { bytes, mime } = await downloadFromGraph(job.mediaId, { token, version: /^v\d+\.\d+$/.test(process.env.META_GRAPH_VERSION?.trim() ?? '') ? process.env.META_GRAPH_VERSION!.trim() : 'v26.0' }); // same rule as config.graphVersion
      const rel = storeBytes(mediaDir(), bytes, mime);
      db.prepare('UPDATE messages SET media_path=?, media_mime=COALESCE(media_mime,?), media_size=?, media_storage=NULL WHERE wa_message_id=?').run(rel, mime, bytes.byteLength, job.waMessageId);
      return;
    } catch (e) { err = e; await new Promise((r) => setTimeout(r, 1000 * 4 ** i)); }
  }
  throw err;
}

/** Webhook media IDs expire after 7 days (Meta media reference), so older pending downloads are skipped. */
export function requeuePending(db: DatabaseSync, onFail: (j: Job) => void): number {
  const rows = db.prepare("SELECT wa_message_id AS w, media_id AS m FROM messages WHERE media_id IS NOT NULL AND media_path IS NULL AND source='webhook' AND ts > ?").all(Date.now() - 7 * 86_400_000) as { w: string; m: string }[];
  for (const r of rows) enqueueMedia(db, { waMessageId: r.w, mediaId: r.m }, onFail);
  return rows.length;
}
