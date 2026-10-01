#!/usr/bin/env bash
# Deus Labs: nightly backup for Accounted on Supabase Cloud, run as a Railway
# Cron service (docker/railway/backup.Dockerfile). Exits non-zero on any
# failure so Railway marks the run failed and notifies.
#
# 1. Downloads every Supabase Storage bucket over Supabase's S3 endpoint
#    (access key = project ref, secret = anon key, session token = service-role
#    JWT; no extra keys needed).
# 2. Runs upstream scripts/self-host/backup.sh with BACKUP_STORAGE_DIR pointing
#    at those files: one set per run = pg_dump (custom format, ACLs kept) +
#    ACL manifest + storage tarball + sha256 manifest, restorable with
#    scripts/self-host/restore.sh. On the 1st of the month the set goes under
#    sets/monthly/ (kept 7+ years), otherwise sets/daily/ (expired by an R2
#    lifecycle rule).
# 3. Optionally (ACCOUNTED_API_KEY + ACCOUNTED_COMPANY_ID) exports SIE4 for
#    every fiscal period via the public API and uploads it under sie/.
# 4. Prints DB and storage size; exits 3 if either crosses the alert
#    threshold (Supabase free plan: 500 MB DB, 1 GB storage).
#
# Env: SUPABASE_PROJECT_REF, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
#      BACKUP_DATABASE_URL (session pooler, postgres user), BACKUP_S3_ENDPOINT,
#      BACKUP_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (R2),
#      optional BACKUP_S3_REGION (R2: auto), ACCOUNTED_URL, ACCOUNTED_API_KEY,
#      ACCOUNTED_COMPANY_ID, DB_ALERT_MB (default 350), STORAGE_ALERT_MB (700).
set -euo pipefail
umask 077
: "${SUPABASE_PROJECT_REF:?}" "${SUPABASE_ANON_KEY:?}" "${SUPABASE_SERVICE_ROLE_KEY:?}"
: "${BACKUP_DATABASE_URL:?}" "${BACKUP_S3_ENDPOINT:?}" "${BACKUP_S3_BUCKET:?}"
export BACKUP_S3_REGION="${BACKUP_S3_REGION:-auto}"

WORK="$(mktemp -d /tmp/backup.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
SB_S3="https://${SUPABASE_PROJECT_REF}.storage.supabase.co/storage/v1/s3"
sb_aws() {
  AWS_ACCESS_KEY_ID="$SUPABASE_PROJECT_REF" AWS_SECRET_ACCESS_KEY="$SUPABASE_ANON_KEY" \
  AWS_SESSION_TOKEN="$SUPABASE_SERVICE_ROLE_KEY" AWS_DEFAULT_REGION=us-east-1 \
    aws --endpoint-url "$SB_S3" "$@"
}
r2() { AWS_DEFAULT_REGION="$BACKUP_S3_REGION" aws --endpoint-url "$BACKUP_S3_ENDPOINT" "$@"; }

# 1. Storage
mkdir -p "$WORK/storage"
buckets="$(sb_aws s3api list-buckets --query 'Buckets[].Name' --output text)"
[ -n "$buckets" ] || { echo "backup: no storage buckets listed (credentials?)" >&2; exit 1; }
for b in $buckets; do
  sb_aws s3 sync --only-show-errors "s3://$b" "$WORK/storage/$b"
done
STORAGE_MB=$(( $(du -sk "$WORK/storage" | cut -f1) / 1024 ))
echo "backup: storage buckets [$buckets] downloaded, ${STORAGE_MB} MB"

# 2. Database + storage set (upstream script)
if [ "$(date -u +%d)" = "01" ]; then KIND=monthly; else KIND=daily; fi
# TMPDIR, not BACKUP_WORKDIR: with BACKUP_WORKDIR set, backup.sh's EXIT trap
# ends on a false `[ -z ... ] &&` test and the script exits 1 after a
# successful run (upstream bug).
BACKUP_STORAGE_DIR="$WORK/storage" BACKUP_LABEL="$KIND" BACKUP_S3_PREFIX="sets/$KIND" \
  TMPDIR="$WORK" bash /opt/backup/backup.sh

# 3. SIE4 per fiscal period (optional until an API key exists)
if [ -n "${ACCOUNTED_API_KEY:-}" ] && [ -n "${ACCOUNTED_COMPANY_ID:-}" ]; then
  : "${ACCOUNTED_URL:?ACCOUNTED_URL is required with ACCOUNTED_API_KEY}"
  api() { curl -fsS -H "Authorization: Bearer ${ACCOUNTED_API_KEY}" "${ACCOUNTED_URL}/api/v1/companies/${ACCOUNTED_COMPANY_ID}/$1"; }
  day="$(date -u +%Y-%m-%d)"
  for pid in $(api fiscal-periods | jq -r '.data[].id'); do
    api "reports/sie-export?period_id=${pid}" > "$WORK/${pid}.se"
    r2 s3 cp --only-show-errors "$WORK/${pid}.se" "s3://${BACKUP_S3_BUCKET}/sie/${day}/${pid}.se"
    echo "backup: SIE4 for period ${pid} uploaded"
  done
else
  echo "backup: SIE export skipped (ACCOUNTED_API_KEY / ACCOUNTED_COMPANY_ID not set)"
fi

# 4. Capacity report
DB_MB=$(psql -X -A -t -v ON_ERROR_STOP=1 -c "select pg_database_size(current_database())/1048576" "$BACKUP_DATABASE_URL")
echo "backup: capacity db=${DB_MB} MB (alert ${DB_ALERT_MB:-350}), storage=${STORAGE_MB} MB (alert ${STORAGE_ALERT_MB:-700})"
if [ "$DB_MB" -ge "${DB_ALERT_MB:-350}" ] || [ "$STORAGE_MB" -ge "${STORAGE_ALERT_MB:-700}" ]; then
  echo "backup: CAPACITY ALERT: approaching Supabase free-plan limits, plan Stage B" >&2
  exit 3
fi
echo "backup: all done"
