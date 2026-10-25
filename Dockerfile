FROM node:24.19.0-bookworm-slim AS portal-build
WORKDIR /build
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci --workspace=@cal-eats/portal --include-workspace-root --ignore-scripts --no-audit --no-fund
RUN npm run build --workspace=@cal-eats/portal

FROM node:24.19.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    CALAI_RUN_MODE=hosted-preview \
    CALAI_HOST=0.0.0.0 \
    CALAI_PORT=4310 \
    PORT=4310 \
    CALAI_DB_PATH=/data/calai-eats.sqlite
WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node apps/api ./apps/api
COPY --chown=node:node apps/web ./apps/web
COPY --chown=node:node packages/contracts ./packages/contracts
COPY --from=portal-build --chown=node:node /build/apps/portal/dist ./apps/portal/dist
COPY --chown=node:node infra ./infra
RUN mkdir -p /data && chown node:node /data

USER node
# Mount /data explicitly in the hosting platform or docker run.
EXPOSE 4310
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "infra/healthcheck.js"]
CMD ["node", "apps/api/src/main.js"]
