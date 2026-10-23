#!/usr/bin/env bash
# Nightly encrypted off-VPS backup (P-009 K12). Run as a Coolify Scheduled Task in the app container, 02:00 COT:
#   cron "0 7 * * *" (UTC)   command: bash scripts/backup.sh
# Target (Juan's choice): dedicated GCS bucket in Juan's GCP (separate from PACS), via S3-compatible HMAC keys.
# Env (names only):
#   DATA_DIR                    default /app/data
#   MEDIA_DIR                   default $DATA_DIR/media
#   BACKUP_TARGET_URL           e.g. https://storage.googleapis.com/wapso-backups   (bucket URL, no trailing slash)
#   BACKUP_ACCESS_KEY_ID        GCS HMAC access id (service account with objectCreator on that bucket only)
#   BACKUP_SECRET_ACCESS_KEY    GCS HMAC secret
#   BACKUP_AGE_RECIPIENT        age public key (age1...). Preferred. Private key stays offline with Juan.
#   BACKUP_PASSPHRASE           fallback if age is not installed: openssl AES-256-CBC + PBKDF2
#   BACKUP_REGION               default auto (GCS ignores it)
# Encrypted output is never readable as SQLite; temp files are removed. Logs contain no data.
set -euo pipefail
DATA_DIR="${DATA_DIR:-/app/data}"
MEDIA_DIR="${MEDIA_DIR:-$DATA_DIR/media}"
: "${BACKUP_TARGET_URL:?BACKUP_TARGET_URL missing}"
: "${BACKUP_ACCESS_KEY_ID:?BACKUP_ACCESS_KEY_ID missing}"
: "${BACKUP_SECRET_ACCESS_KEY:?BACKUP_SECRET_ACCESS_KEY missing}"
if [[ -z "${BACKUP_AGE_RECIPIENT:-}" && -z "${BACKUP_PASSPHRASE:-}" ]]; then echo "BACKUP_AGE_RECIPIENT or BACKUP_PASSPHRASE missing" >&2; exit 2; fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DOW="$(date -u +%u)"   # 7 = Sunday -> full media
WORK="$(mktemp -d "${TMPDIR:-/tmp}/wapso-backup.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
umask 077

fail() { echo "[backup] FAILED: $1" >&2; node -e "fetch(process.env.ALERT_WEBHOOK_URL||'',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app:'wapso',type:'backup_failed',details:{step:process.argv[1]}})}).catch(()=>{})" "$1" 2>/dev/null || true; exit 1; }

# 1) Consistent snapshot (never a plain copy of a live WAL DB) + integrity check.
node -e '
const { DatabaseSync } = require("node:sqlite");
const [src, dst] = process.argv.slice(1);
const db = new DatabaseSync(src); db.exec("PRAGMA busy_timeout=10000"); db.exec(`VACUUM INTO '"'"'${dst.replace(/'"'"'/g, "")}'"'"'`); db.close();
const s = new DatabaseSync(dst); const r = s.prepare("PRAGMA integrity_check").get();
if (Object.values(r)[0] !== "ok") { console.error("integrity_check failed"); process.exit(1); }
' "$DATA_DIR/inbox.db" "$WORK/inbox.db" || fail snapshot

# 2) Tar snapshot + media (incremental by mtime since last run, full on Sundays).
STATE="$DATA_DIR/.last_backup"
LIST="$WORK/media.list"
if [[ -d "$MEDIA_DIR" ]]; then
  if [[ "$DOW" == "7" || ! -f "$STATE" ]]; then KIND=full; find "$MEDIA_DIR" -type f ! -path '*/tmp/*' > "$LIST"
  else KIND=incr; find "$MEDIA_DIR" -type f ! -path '*/tmp/*' -newer "$STATE" > "$LIST"; fi
else KIND=full; : > "$LIST"; fi
tar -C "$WORK" -cf "$WORK/bundle.tar" inbox.db || fail tar
[[ -s "$LIST" ]] && { tar -rf "$WORK/bundle.tar" -P -T "$LIST" || fail tar-media; }
gzip -9 "$WORK/bundle.tar"

# 3) Encrypt.
OUT="$WORK/wapso-$STAMP-$KIND.tar.gz"
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]] && command -v age >/dev/null; then
  OUT="$OUT.age"; age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT" "$WORK/bundle.tar.gz" || fail encrypt
elif [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  OUT="$OUT.enc"; openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$WORK/bundle.tar.gz" -out "$OUT" -pass env:BACKUP_PASSPHRASE || fail encrypt
else fail "age not installed and no BACKUP_PASSPHRASE"; fi
rm -f "$WORK/bundle.tar.gz" "$WORK/inbox.db"

# 4) Upload (S3 SigV4 via curl; works with GCS HMAC interoperability).
KEY="$(date -u +%Y/%m)/$(basename "$OUT")"
# Credentials go to curl on stdin (-K -), never on the command line where ps can see them.
printf 'user = "%s:%s"\n' "$BACKUP_ACCESS_KEY_ID" "$BACKUP_SECRET_ACCESS_KEY" | curl -K - -fsS --retry 3 -X PUT --upload-file "$OUT" \
  --aws-sigv4 "aws:amz:${BACKUP_REGION:-auto}:s3" \
  -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" "$BACKUP_TARGET_URL/$KEY" -o /dev/null || fail upload

touch "$STATE"
echo "[backup] ok kind=$KIND bytes=$(wc -c < "$OUT" | tr -d ' ') media_files=$(wc -l < "$LIST" | tr -d ' ')"
