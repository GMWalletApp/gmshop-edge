# syntax=docker/dockerfile:1.7

FROM oven/bun:1.4.2-alpine AS build

ENV CI=true

WORKDIR /app

COPY --link package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile --ignore-scripts

COPY --link . .
RUN bun run build:bun

FROM oven/bun:1.4.2-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    GMSHOP_DATA_DIR=/var/lib/gmshop

WORKDIR /app

RUN addgroup --system --gid 10001 gmshop \
    && adduser --system --disabled-password --no-create-home --uid 10001 --ingroup gmshop gmshop \
    && mkdir -p /var/lib/gmshop \
    && chmod 0700 /var/lib/gmshop \
    && chown gmshop:gmshop /var/lib/gmshop

COPY --link --from=build --chown=10001:10001 /app/.output ./.output
COPY --link --from=build --chown=10001:10001 /app/drizzle ./drizzle
COPY --link --from=build --chown=10001:10001 /app/package.json /app/tsconfig.json ./
COPY --link --from=build --chown=10001:10001 /app/scripts/data.ts ./scripts/data.ts
COPY --link --from=build --chown=10001:10001 /app/src/server/runtime/types.ts ./src/server/runtime/types.ts
COPY --link --from=build --chown=10001:10001 /app/src/server/runtime/node/data-layout.ts /app/src/server/runtime/node/migrations.ts /app/src/server/runtime/node/object-storage.ts ./src/server/runtime/node/

USER gmshop

EXPOSE 3000
VOLUME ["/var/lib/gmshop"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["bun", ".output/server/index.mjs"]
