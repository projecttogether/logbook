# One image for every Logbook process. The command selects the role:
#   web      Next.js server (port 3000)
#   worker   pg-boss worker: notifications, webhook, Keycloak directory sync
#   migrate  applies database migrations, then exits
#   cli      operator commands, e.g. `cli settings list` (src/cli); also on the PATH

FROM node:26.13.1-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS runtime
LABEL org.opencontainers.image.title="Logbook" \
      org.opencontainers.image.description="ProjectTogether's log of decisions, updates, and learnings, with a consent-based decision process." \
      org.opencontainers.image.source="https://github.com/projecttogether/logbook" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    MIGRATIONS_DIR=/app/drizzle
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --chmod=755 docker-cli.sh /usr/local/bin/cli
# The Deploy workflow sets the version (the first 12 characters of the
# commit); images built from source have none.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["web"]
