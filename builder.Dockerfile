# The builder studio's sandbox image — "the monorepo, warm" (builder-studio.md §4.1, #626).
#
# Context is the REPO ROOT (this file lives there so `wrangler` builds with the
# whole monorepo visible; .dockerignore keeps it sane). Everything expensive
# happens at build time — install + full build — so a session's cold start is
# container boot, not pnpm install.
#
# Base: cloudflare/sandbox — pinned to the @cloudflare/sandbox SDK version in
# apps/builder/package.json; the two MUST move together.
FROM docker.io/cloudflare/sandbox:0.12.5

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

# Fail the BUILD, not a session, if the native module doesn't load on amd64.
RUN cd packages/adapter-sqlite && node -e "new (require('better-sqlite3'))(':memory:'); console.log('better-sqlite3 ok')"

# Generated-app dev ports (the demo convention the scaffolds follow) — exposed
# for local `wrangler dev`; production preview goes through exposePort.
EXPOSE 8871 5271
