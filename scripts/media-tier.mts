// Nightly media tiering (hot disk -> private bucket). Run as a Coolify Scheduled Task in the app container:
//   cron "30 7 * * *" (UTC = 02:30 COT, after backup.sh at 02:00)   command: npm run media:tier
// Moves media files whose newest message is older than MEDIA_HOT_DAYS (default 7) to MEDIA_BUCKET_URL.
// Local copy is deleted only after the object is verified (size + MD5 ETag). Safe to re-run; resumes where it stopped.
// Flags: --dry-run (count only), --limit N (default 5000 files per run).
// Env (names only): DATA_DIR, MEDIA_DIR, MEDIA_BUCKET_URL, MEDIA_BUCKET_ACCESS_KEY_ID, MEDIA_BUCKET_SECRET_ACCESS_KEY, MEDIA_BUCKET_REGION, MEDIA_HOT_DAYS.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureInboxSchema } from '../src/lib/inbox-store.ts';
import { mediaDir } from '../src/lib/media-store.ts';
import { bucketConfig } from '../src/lib/bucket.ts';
import { hotDays, selectTierCandidates, tierMedia } from '../src/lib/media-tier.ts';
import { alert } from '../src/lib/alert.ts';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const li = args.indexOf('--limit');
const limit = li >= 0 ? Math.max(1, Number(args[li + 1]) || 5000) : 5000;

const cfg = bucketConfig();
if (!cfg) { console.warn('[media-tier] MEDIA_BUCKET_* not set: tiering disabled, nothing to do'); process.exit(0); }
const db = new DatabaseSync(path.join(process.env.DATA_DIR || './data', 'inbox.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;');
ensureInboxSchema(db);
const days = hotDays();
if (dry) {
  const n = selectTierCandidates(db, Date.now() - days * 86_400_000, limit).length;
  console.log(`[media-tier] dry-run days=${days} candidates=${n}`);
  process.exit(0);
}
const t0 = Date.now();
const r = await tierMedia({ db, dir: mediaDir(), cfg, days, limit, log: (m) => console.error(m) });
console.log(`[media-tier] days=${days} scanned=${r.scanned} moved=${r.moved} cleaned=${r.cleaned} skipped=${r.skipped} failed=${r.failed} ms=${Date.now() - t0}`);
if (r.failed > 0) { await alert('media_tier_failed', { failed: r.failed, moved: r.moved }); process.exit(1); }
