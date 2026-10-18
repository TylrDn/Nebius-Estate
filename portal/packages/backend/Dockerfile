# Modified by Taylor Dean from Backstage create-app 0.9.2 (v1.55.0):
# Nebius Estate app/plugin configuration, backend composition and local verification.
# Source details and retained notices: docs/source-provenance.md, third_party/licenses/.
# Nebius Estate backend image (serves the built app too). Build context: portal/.
#
#   yarn install --immutable && yarn tsc && yarn build:backend   # same Node version as FROM
#   yarn build-image
#
# Run ONE replica. The inventory snapshot and connector states live in process memory and the
# sync task is scheduled per process (scope: local), so a second replica would serve a different
# snapshot and call the APIs twice. PostgreSQL holds everything that must survive a restart.
#
# Starts in live mode with app-config.yaml + app-config.production.yaml; the repository the portal
# describes is mounted read-only at /app/repo (nebiusEstate.repoRoot).

# node:24.22.0-trixie-slim, pinned by index digest (multi-arch).
FROM node:24.22.0-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315

# Build dependencies for native modules (better-sqlite3 falls back to a source build).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*

# Run as the least-privileged `node` user. WORKDIR is then created as `node` (needs BuildKit).
USER node
WORKDIR /app

COPY --chown=node:node .yarn ./.yarn
COPY --chown=node:node .yarnrc.yml backstage.json ./

ENV NODE_ENV=production

# Workspace skeleton first (package.json files only), so dependency layers cache well.
COPY --chown=node:node yarn.lock package.json packages/backend/dist/skeleton.tar.gz ./
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz

RUN --mount=type=cache,target=/home/node/.cache/yarn,sharing=locked,uid=1000,gid=1000 \
    yarn workspaces focus --all --production && rm -rf "$(yarn cache clean)"

COPY --chown=node:node packages/backend/dist/bundle.tar.gz app-config.yaml app-config.production.yaml ./
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz

CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]
