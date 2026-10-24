FROM node:24.19.0-bookworm-slim

ENV NODE_ENV=production \
    CALAI_RUN_MODE=hosted-preview \
    CALAI_HOST=0.0.0.0 \
    CALAI_PORT=4310 \
    PORT=4310 \
    CALAI_DB_PATH=/data/calai-eats.sqlite
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node apps/api/package.json apps/api/package.json
COPY --chown=node:node apps/web/package.json apps/web/package.json
COPY --chown=node:node packages/contracts/package.json packages/contracts/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund --offline
COPY --chown=node:node apps ./apps
COPY --chown=node:node packages ./packages
COPY --chown=node:node infra ./infra
RUN mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 4310
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "infra/healthcheck.js"]
CMD ["node", "apps/api/src/main.js"]
