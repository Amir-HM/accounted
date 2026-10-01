# Deus Labs: Railway variant of docker/cron.Dockerfile.
#
# Railway has no bind mounts, so the crontab is baked into the image instead of
# being mounted at /etc/supercronic/crontab. Build with the repo root as context:
#   docker build -f docker/railway/cron.Dockerfile .
# Base image, supercronic version and checksums are copied from
# docker/cron.Dockerfile; keep them in sync when rebasing on upstream.
#
# The whatsapp-inbox lines are dropped: that extension is not enabled here and
# its sweep answers 503 EXTENSION_DISABLED every minute (other disabled
# extensions answer a 200 no-op), which would show as a failing job.
#
# tini is PID 1: compose runs this container with `init: true`, Railway has no
# equivalent, and supercronic as PID 1 tries to reap processes and dies with
# "Failed to fork exec: no such file or directory".
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

ARG SUPERCRONIC_VERSION=v0.2.33
ARG TARGETARCH
ARG SUPERCRONIC_SHA256_AMD64=feefa310da569c81b99e1027b86b27b51e6ee9ab647747b49099645120cfc671
ARG SUPERCRONIC_SHA256_ARM64=f1f8585c66de020fef494dd636058f99949d108f569fef00016a1c8b9eb145b3

RUN apk upgrade --no-cache \
    && apk add --no-cache curl tini \
    && case ${TARGETARCH} in \
         amd64) ARCH=linux-amd64; SHA=${SUPERCRONIC_SHA256_AMD64} ;; \
         arm64) ARCH=linux-arm64; SHA=${SUPERCRONIC_SHA256_ARM64} ;; \
         *)     ARCH=linux-amd64; SHA=${SUPERCRONIC_SHA256_AMD64} ;; \
       esac \
    && curl -fsSL "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-${ARCH}" \
       -o /usr/local/bin/supercronic \
    && echo "${SHA}  /usr/local/bin/supercronic" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/supercronic

COPY docker/crontab.self-hosted /tmp/crontab.self-hosted
RUN mkdir -p /etc/supercronic \
    && grep -v 'whatsapp-inbox/' /tmp/crontab.self-hosted > /etc/supercronic/crontab \
    && chmod 0644 /etc/supercronic/crontab \
    && rm /tmp/crontab.self-hosted

USER nobody:nobody

ENTRYPOINT ["/sbin/tini", "--", "supercronic"]
CMD ["/etc/supercronic/crontab"]
