# syntax=docker/dockerfile:1

# Server TypeScript runs directly through Node's built-in type stripping, which
# refuses files under node_modules. Workspace packages therefore stay where they
# are (packages/*/src) and node_modules only holds pnpm's symlinks to them.

ARG NODE_IMAGE=node:24-slim

# --- base: Node + the pnpm version pinned in package.json "packageManager" ----
# Installed with npm rather than corepack: corepack is no longer bundled from
# Node 25 on, and the corepack shipped with Node 24 cannot launch pnpm 12.
FROM ${NODE_IMAGE} AS base
WORKDIR /app
COPY package.json ./
RUN --mount=type=cache,id=npm,target=/root/.npm \
    npm install --global --no-audit --no-fund \
      "$(node -p 'require("./package.json").packageManager.split("+")[0]')"

# --- manifests: everything pnpm needs to resolve the workspace ---------------
# One COPY per workspace package keeps the directory layout (globs would
# flatten it). Add a line here when a package is added under packages/.
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmr[c] ./
COPY packages/core/package.json packages/core/
COPY packages/agents/package.json packages/agents/
COPY packages/host/package.json packages/host/
COPY packages/web/package.json packages/web/

# --- deps: full install (dev deps included) for the web build ----------------
# --ignore-scripts skips the root `prepare` hook (git hooks) and dependency
# build scripts; nothing in the dependency tree needs them to build or run.
FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm/store

# --- build: Vite build of the SPA into packages/web/dist ---------------------
FROM deps AS build
COPY . .
RUN pnpm build

# --- prod-deps: runtime dependencies only ------------------------------------
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --store-dir /pnpm/store

# --- runtime ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_DIR=/app/packages/web/dist
WORKDIR /app

# Manifests, lockfile and node_modules (with workspace symlinks into packages/).
COPY --from=prod-deps /app ./
COPY packages/core/src packages/core/src
COPY packages/agents/src packages/agents/src
COPY packages/host/src packages/host/src
COPY --from=build /app/packages/web/dist packages/web/dist

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => r.json()).then((j) => process.exit(j.ok === true ? 0 : 1), () => process.exit(1))"]

CMD ["node", "packages/host/src/main.ts"]
