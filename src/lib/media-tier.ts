// Media tiering (hot local disk -> private bucket). Pure: no '@/' imports; db, bucket config and fetch are injected.
// Per file: verify-or-upload, verify again (size + MD5 ETag), record in DB, and only then delete the local copy.
// Idempotent and resumable: a crash at any step is repaired by the next run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { headObject, objectKeyFor, putObject, type BucketConfig } from './bucket.ts';
import { resolveMediaPath } from './media-store.ts';

export function hotDays(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MEDIA_HOT_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 7;
}

/** Files whose newest referencing message is older than the cutoff. Includes rows already marked 'bucket'
 *  whose local copy still exists (crash between DB update and delete) so the next run cleans them up. */
export function selectTierCandidates(db: DatabaseSync, cutoffMs: number, limit = 5000): { rel: string; mime: string | null }[] {
  return db.prepare(
    `SELECT media_path AS rel, MAX(media_mime) AS mime FROM messages WHERE media_path IS NOT NULL
     GROUP BY media_path HAVING MAX(ts) < ? ORDER BY MAX(ts) ASC LIMIT ?`
  ).all(cutoffMs, limit) as { rel: string; mime: string | null }[];
}

export type TierResult = { scanned: number; moved: number; cleaned: number; skipped: number; failed: number };

export async function tierMedia(opts: {
  db: DatabaseSync; dir: string; cfg: BucketConfig; now?: number; days?: number; limit?: number;
  fetchImpl?: typeof fetch; log?: (m: string) => void;
}): Promise<TierResult> {
  const { db, dir, cfg } = opts;
  const f = opts.fetchImpl ?? fetch;
  const cutoff = (opts.now ?? Date.now()) - (opts.days ?? 7) * 86_400_000;
  const out: TierResult = { scanned: 0, moved: 0, cleaned: 0, skipped: 0, failed: 0 };
  for (const { rel, mime } of selectTierCandidates(db, cutoff, opts.limit)) {
    out.scanned++;
    const full = resolveMediaPath(dir, rel);
    if (!full || !fs.existsSync(full)) { out.skipped++; continue; } // already only in the bucket, or missing
    try {
      const bytes = fs.readFileSync(full);
      const md5 = crypto.createHash('md5').update(bytes);
      const md5hex = md5.copy().digest('hex'), md5b64 = md5.digest('base64');
      const key = objectKeyFor(rel, cfg.prefix);
      const matches = (o: Awaited<ReturnType<typeof headObject>>) => !!o && o.size === bytes.byteLength && o.etag === md5hex;
      let info = await headObject(cfg, key, f);
      const already = matches(info);
      if (!already) {
        await putObject(cfg, key, bytes, mime || 'application/octet-stream', md5b64, f);
        info = await headObject(cfg, key, f);
        if (!matches(info)) throw new Error('bucket verify mismatch');
      }
      // Verified: record first, delete second.
      db.prepare("UPDATE messages SET media_storage='bucket', media_object_key=? WHERE media_path=?").run(key, rel);
      fs.unlinkSync(full);
      if (already) out.cleaned++; else out.moved++;
    } catch (e) {
      out.failed++;
      opts.log?.(`[media-tier] failed: ${e instanceof Error ? e.message : 'error'}${(e as { status?: number })?.status ? ` status=${(e as { status: number }).status}` : ''}`);
    }
  }
  return out;
}
