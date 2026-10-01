# Deus Labs: the upstream app image, unchanged except for one Next.js setting.
#
# Route handlers build redirects from `new URL(request.url).origin`. In the
# standalone build Next.js only uses the request's Host header for that when
# experimental.trustHostHeader is on; otherwise it uses the bind address, so
# behind Railway/Cloudflare the auth callback and MCP OAuth authorize redirect
# to https://[::]:3000/... (or https://0.0.0.0:3000/... with the default
# HOSTNAME). Railway's edge only routes our own domains to this service, so
# trusting Host is safe here. Pin = same digest as before; bump both together.
FROM ghcr.io/erp-mafia/gnubok:cf60a3f@sha256:8d12cc7e0dd516a76edefd4c66e242c1ff4e22eaba77a512cfdfcf01344c755b

USER root
# Set in both places Next.js reads it (standalone server.js config and the
# bundle's required-server-files.json, copied into /app/.next at every start by
# docker-entrypoint.sh from /opt/gnubok-template). The flag alone is not
# enough: NextNodeServer.attachRequestMeta prefers the bind address
# (fetchHostname:port) over trustHostHeader, so that one condition is
# reordered too. Patches Next.js, not Accounted; re-check on every image bump.
RUN sed -i 's/"trustHostHeader":false/"trustHostHeader":true/' /app/server.js \
    && sed -i 's/"trustHostHeader": false/"trustHostHeader": true/' /opt/gnubok-template/.next/required-server-files.json \
    && sed -i 's/const initUrl = this.fetchHostname \&\& this.port ?/const initUrl = !this.nextConfig.experimental.trustHostHeader \&\& this.fetchHostname \&\& this.port ?/' /app/node_modules/next/dist/server/next-server.js \
    && grep -q 'const initUrl = !this.nextConfig.experimental.trustHostHeader && this.fetchHostname' /app/node_modules/next/dist/server/next-server.js \
    && grep -q '"trustHostHeader":true' /app/server.js \
    && grep -q '"trustHostHeader": true' /opt/gnubok-template/.next/required-server-files.json
USER nextjs
