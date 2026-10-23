// Where to read a stored media file from: local disk first, else the private bucket (server-side stream).
// Pure: no '@/' imports; bucket config and fetch are injected so tests can mock the bucket.
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { getObject, type BucketConfig } from './bucket.ts';
import { resolveMediaPath } from './media-store.ts';

export type MediaSource = { body: ReadableStream; size: number | null; from: 'local' | 'bucket' };

export async function openMediaSource(opts: {
  dir: string; rel: string | null | undefined; objectKey: string | null | undefined; cfg: BucketConfig | null; fetchImpl?: typeof fetch;
}): Promise<MediaSource | null> {
  const full = resolveMediaPath(opts.dir, opts.rel);
  if (full && fs.existsSync(full)) {
    return { body: Readable.toWeb(fs.createReadStream(full)) as ReadableStream, size: fs.statSync(full).size, from: 'local' };
  }
  if (!opts.cfg || !opts.objectKey || !/^[a-z0-9_-]+\/[a-f0-9]{2}\/[a-f0-9]{64}\.[a-z0-9]{1,5}$/.test(opts.objectKey)) return null;
  const r = await getObject(opts.cfg, opts.objectKey, opts.fetchImpl);
  if (!r.ok || !r.body) { await r.body?.cancel().catch(() => {}); return null; }
  const len = r.headers.get('content-length');
  return { body: r.body, size: len ? Number(len) : null, from: 'bucket' };
}
