# Kapso exit: cutover runbook (P-009)

Branch `kapso-exit` in `~/Dev/whatsapp-cloud-inbox` (local branch, not pushed). Nothing is live until merged and `INBOX_SOURCE=local` is set.

## What changes
- `INBOX_SOURCE=kapso` (default): behaves exactly as today, plus: PII-safe logs, metrics 10 s timeout + `Object.hasOwn`, startup config check, alerts.
- `INBOX_SOURCE=local`: Meta webhook `POST /api/webhooks/meta` writes to our SQLite (`contacts`, `conversations`, `messages`, `statuses`, `meta_events`, `kv`); media downloaded to `MEDIA_DIR`; sends go straight to `graph.facebook.com`; the list/messages/metrics/media routes read our DB; UI polls every 3 s (30 s hidden) with a `since` cursor (204 when nothing changed). 24 h window enforced (409 `window_closed`; templates exempt).
- Conversation id in local mode = contact key (phone digits, else `@username`, else BSUID). Old Kapso-id read marks/assignments are rekeyed on boot via `contacts.legacy_kapso_id`.

## Env vars (names only; values in Coolify)
Existing: `PHONE_NUMBER_ID`, `WABA_ID`, `DATA_DIR`, `AUTH_SECRET`, `APP_ORIGIN`, `KAPSO_API_KEY` (keep until Kapso is cancelled).
New: `INBOX_SOURCE`, `META_ACCESS_TOKEN`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` (≥32 chars), `META_GRAPH_VERSION`, `MEDIA_DIR` (optional),
alerts `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`, `ALERT_RESEND_API_KEY` and/or `ALERT_WEBHOOK_URL`,
backup `BACKUP_TARGET_URL`, `BACKUP_ACCESS_KEY_ID`, `BACKUP_SECRET_ACCESS_KEY`, `BACKUP_AGE_RECIPIENT` or `BACKUP_PASSPHRASE`.
Production refuses to boot when a required one is missing (`src/instrumentation.ts`).

## Meta dashboard steps (K0, Juan)
1. Business Settings → System Users: System User with only this app + WABA; never-expiring token with `whatsapp_business_messaging`, `whatsapp_business_management` → `META_ACCESS_TOKEN`.
2. App → Settings → Basic → App secret → `META_APP_SECRET`.
3. `GET /v26.0/{WABA_ID}/subscribed_apps` → note which app(s) are subscribed (Kapso's or ours).
4. At cutover: App → WhatsApp → Configuration → Callback URL `https://whatsapp-mundoradiologico.tekobo.io/api/webhooks/meta`, verify token = `META_WEBHOOK_VERIFY_TOKEN`, subscribe field `messages`. Then `POST /{WABA_ID}/subscribed_apps` with our token.

## Cutover order (quiet window after 18:00)
0. Deploy this branch with `INBOX_SOURCE=kapso` (no visible change). Run `npm run kapso:export -- --dry-run` in the Coolify terminal.
1. Full export: `npm run kapso:export` (≈26k conversations → ≈26k+ Kapso GETs, a few hours; idempotent, resumable by rerun). Check the report in `$DATA_DIR/export-report-*.json` (mismatches by id only) and `du -sh /app/data`.
2. Delta: `npm run kapso:export -- --since=<step 1 start>`.
3. Switch the Meta webhook to ours (above), set `INBOX_SOURCE=local`, redeploy.
4. Delta again: `--since=<step 2 time − 10 min>`.
5. Smoke test: inbound text + image within 5 s, reply delivered with ticks, template on a closed window, metrics load.
6. Unsubscribe Kapso's app. Keep Kapso readable 7 days, then cancel and remove `KAPSO_API_KEY` (K14).

## Rollback (within 7 days)
Set `INBOX_SOURCE=kapso`, redeploy, re-point/re-subscribe Kapso's webhook. Messages received in between stay in our DB only.

## Backups (K12)
Coolify → app → Scheduled Tasks: `bash scripts/backup.sh`, cron `0 7 * * *` (02:00 COT). Bucket: dedicated GCS bucket (not the PACS project data), HMAC key for a service account with only `storage.objectCreator` on it; lifecycle 30 daily / 12 monthly. `age` is preferred (`BACKUP_AGE_RECIPIENT`, private key offline); if `age` isn't in the image the script uses openssl with `BACKUP_PASSPHRASE`.
Restore drill: download → `age -d -i key.txt f.age > f.tar.gz` (or `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE`) → `tar xzf` → open `inbox.db`, compare row counts.

## Tests
`npm test` (node --test): signature check, verify challenge, parse/ignore other numbers, @username key, idempotent insert, forward-only statuses, dedupe, legacy rekey, hasOwn, log scrubbing, alert limiter, config checks, media traversal/dedupe/host allowlist.


## Rollback note for staff
Messages handled while `INBOX_SOURCE=local` are not in Kapso. If we roll back to Kapso, tell staff that those conversations will not appear there.

## Media tiering (hot disk -> private bucket)
Media newer than `MEDIA_HOT_DAYS` (default 7) stays in `MEDIA_DIR`; older files move nightly to a private GCS bucket. The media route serves the local file first, else streams the object from the bucket server-side (same login, Content-Type, Content-Disposition and nosniff rules). The browser never gets a bucket URL. The local copy is deleted only after the object's size and MD5 (ETag) match. Runs are idempotent: a stopped run resumes the next night.

Without the `MEDIA_BUCKET_*` vars tiering is off (one startup warning) and everything stays local.

**Steps for Juan (once):**
1. Create the bucket in the PACS region (`us-east1`, project `pacs-test`), separate from the backups bucket. Private, uniform access, public access prevention:
   `gcloud storage buckets create gs://<media-bucket> --project=pacs-test --location=us-east1 --default-storage-class=STANDARD --uniform-bucket-level-access --public-access-prevention`
   Encryption at rest: Google default encryption (nothing to configure). Leave soft delete on (default 7 days).
2. Lifecycle: **no delete rule** (this bucket is the only copy of old media). Optional cost rule later: move objects to Nearline after 90 days (`SetStorageClass`, age 90). Don't add one now.
3. Service account with access to this bucket only:
   `gcloud iam service-accounts create wapso-media --project=pacs-test`
   `gcloud storage buckets add-iam-policy-binding gs://<media-bucket> --member=serviceAccount:wapso-media@pacs-test.iam.gserviceaccount.com --role=roles/storage.objectCreator`
   `gcloud storage buckets add-iam-policy-binding gs://<media-bucket> --member=serviceAccount:wapso-media@pacs-test.iam.gserviceaccount.com --role=roles/storage.objectViewer`
   (No delete permission is needed: an object that already matches is not uploaded again.)
4. HMAC key: `gcloud storage hmac create wapso-media@pacs-test.iam.gserviceaccount.com --project=pacs-test`. The secret is shown once; paste it straight into Coolify, never in chat or files.
5. Coolify → app → Environment: `MEDIA_BUCKET_URL=https://storage.googleapis.com/<media-bucket>`, `MEDIA_BUCKET_ACCESS_KEY_ID`, `MEDIA_BUCKET_SECRET_ACCESS_KEY`, optional `MEDIA_BUCKET_REGION=auto`, `MEDIA_HOT_DAYS=7`. Redeploy.
6. Coolify → Scheduled Tasks: command `npm run media:tier`, cron `30 7 * * *` (02:30 COT, after the backup). First check with `npm run media:tier -- --dry-run`.
7. Verify: `gcloud storage buckets describe gs://<media-bucket>` shows uniform access on and public access prevention `enforced`.

**Kapso export:** imported media is written to `MEDIA_DIR` like webhook media (about 28 GB / 40,660 files at first; the VPS has ~90 GB free) and moves on the next tier runs, up to 5,000 files per run (`--limit N` to change). Expect several nights, or run it by hand a few times after the export.

**Backups:** `backup.sh` only backs up media still on disk. Tiered media lives only in the bucket (Google's durability plus soft delete), so don't add a delete lifecycle rule to it.
