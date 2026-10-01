# Deus Labs: nightly backup job for Railway (Cron service, runs and exits).
# Build with the repo root as context:
#   docker build -f docker/railway/backup.Dockerfile .
# See docker/railway/backup-run.sh for what it does and the env it needs.
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

# pg_dump must match the server major version (Supabase: Postgres 17).
RUN apk upgrade --no-cache \
    && apk add --no-cache bash coreutils tar gzip curl jq aws-cli postgresql17-client tini

COPY scripts/self-host/backup.sh scripts/self-host/acl-manifest.sql /opt/backup/
COPY docker/railway/backup-run.sh /opt/backup/backup-run.sh
RUN chmod 0755 /opt/backup/backup.sh /opt/backup/backup-run.sh

USER nobody:nobody
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/opt/backup/backup-run.sh"]
