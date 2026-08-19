# external-vertical

A Substrat vertical built **from published packages**, standing in for a repo
outside this monorepo. It depends on `@substrat-run/*` at real semver ranges (no
`workspace:*`) and is **not** a workspace member — `pnpm install` here resolves
everything from npm, exactly as a real external project would. This is
[first-flow.md](../../docs/briefs/first-flow.md) slice 2: the "build an app
outside the repo" half.

## What it is

One deployable Cloudflare Worker that composes:

- `@substrat-run/kernel` + `@substrat-run/contracts` — the runtime and vocabulary
- `@substrat-run/adapter-cloudflare` — the Durable-Object scope host
- `@substrat-run/engine-workorder` — a **published engine**, proving engines
  resolve and bundle from npm
- [`src/notes.ts`](src/notes.ts) — **your own module**, a minimal one

It is self-contained: it embeds its own control plane and seeds its own tenant and
scope. (Registering into a separately-deployed shared control plane is slice 4.)

## Run it

```sh
pnpm install       # from within this monorepo, add --ignore-workspace (see below)
pnpm dev           # wrangler dev on real workerd — no Cloudflare account needed
```

Then **open <http://localhost:8787> in your browser**: a tiny built-in page lets
you *Seed world*, add notes, and see them — driving the same API below. (The `dev`
script turns on the `x-principal` dev-header auth the page uses.)

> **Running from inside this repo:** `examples/` is deliberately **not** a pnpm
> workspace member, so a plain `pnpm install` here would target the whole
> monorepo. Use `pnpm install --ignore-workspace` to install it standalone from
> the registry, the way a real external checkout does. A genuine checkout outside
> the repo just runs `pnpm install`.

### Or drive the API directly

```sh
# provision the world once
curl -s -X POST http://localhost:8787/seed

# act as the seeded user
U=01JZ0000000000000000000003
curl -s -X POST -H "x-principal: $U" -H 'content-type: application/json' \
  -d '{"text":"first note"}' http://localhost:8787/api/notes
curl -s -H "x-principal: $U" http://localhost:8787/api/notes
curl -s -H "x-principal: $U" http://localhost:8787/api/workorders   # [] — engine registered
```

## Deploy it

```sh
pnpm cf:deploy      # needs a Workers Paid plan (Durable Object SQLite)
```

`ALLOW_DEV_HEADER` is **not** set on deploy, so a deployed worker is fail-closed
until you wire real auth. See the Callout demo's worker for the Better Auth
seam; the kernel only ever receives the resolved `PrincipalId`.

## The shape to copy

- **Your module** ([`src/notes.ts`](src/notes.ts)) is a manifest + migrations +
  operations. Every operation checks a permission first, parses its input, and
  emits a kernel-stamped event — the rules the platform enforces mechanically.
- **The worker** ([`src/worker.ts`](src/worker.ts)) bundles the modules into a
  `ScopeDO`, exports the `ControlPlaneDO`, and resolves a principal → `getScope` →
  `invoke`. Adding another engine is one import plus one entry in `MODULES` and its
  entitlement key in the seed.
