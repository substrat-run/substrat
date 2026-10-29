# The builder studio's sandbox image — "the monorepo, warm" (builder-studio.md §4.1, #626).
#
# Context is the REPO ROOT (this file lives there so `wrangler` builds with the
# whole monorepo visible; .dockerignore keeps it sane). Everything expensive
# happens at build time — install + full build — so a session's cold start is
# container boot, not pnpm install.
#
# Base: cloudflare/sandbox — pinned to the @cloudflare/sandbox SDK version in
# apps/builder/package.json; the two MUST move together.
FROM docker.io/cloudflare/sandbox:0.12.14@sha256:b8175e89ae5efd83987ffd5056f57c28c390fd5706d42ef70fb669e275248e7b

# The repo pins pnpm@10.10.0 via packageManager. The sandbox base image ships
# node WITHOUT corepack, so install pnpm the plain way — same pinned version.
RUN npm install -g pnpm@10.10.0

WORKDIR /workspace/substrat
COPY . .

# Warm everything: node_modules (native modules built for linux/amd64 here —
# the one thing mode A can never verify, §3.1) and every package's dist, so the
# tier-1 gates and the generated apps' dev servers start instantly.
RUN pnpm install --frozen-lockfile
RUN pnpm -r build

# The model phase precedes a project's package manifest. Published project deps
# take precedence once installed; this ancestor supplies the initial contract types.
RUN ln -s /workspace/substrat/node_modules /workspace/node_modules && mkdir -p /workspace/projects && printf '{"type":"module"}\n' > /workspace/projects/package.json

# Project installs/build scripts run as this user, without write access to the
# platform toolchain baked into the image. Each build gets its own container.
RUN (find packages/cli/dist packages/contracts/dist packages/boundary-lint/dist apps/builder/src -type f -exec sha256sum {} \; ; sha256sum pnpm-lock.yaml builder.Dockerfile) | sort | sha256sum > .toolchain-id
RUN useradd --create-home --shell /bin/sh substrat-build && find /workspace/substrat -perm /022 -exec chmod go-w {} +

# Fail the BUILD, not a session, if the native module doesn't load on amd64.
RUN cd packages/adapter-sqlite && node -e "new (require('better-sqlite3'))(':memory:'); console.log('better-sqlite3 ok')"

# Generated-app dev ports (the demo convention the scaffolds follow) — exposed
# for local `wrangler dev`; production preview goes through exposePort.
EXPOSE 8871 5271
