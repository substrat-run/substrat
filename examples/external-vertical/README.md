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
# provision the world once (tenant → entitlements → scope → activate → role)
curl -s -X POST http://localhost:8787/seed

# act as the seeded user
U=01JZ0000000000000000000003
curl -s -X POST -H "x-principal: $U" -H 'content-type: application/json' \
  -d '{"text":"first note"}' http://localhost:8787/api/notes
curl -s -H "x-principal: $U" http://localhost:8787/api/notes
curl -s -H "x-principal: $U" http://localhost:8787/api/workorders   # [] — engine registered
```

Both list routes are **paged**. The body is the entries and the walk rides in a
`Link` header, so a client follows a URL rather than assembling a cursor:

```sh
curl -si -H "x-principal: $U" 'http://localhost:8787/api/notes?limit=2' | grep -i '^link:'
# link: <http://localhost:8787/api/notes?limit=2&cursor=01M1…>; rel="next"
```

No `rel="next"` means the walk is over.

## Deploy it

```sh
pnpm cf:deploy      # needs a Workers Paid plan (Durable Object SQLite)
```

`ALLOW_DEV_HEADER` is **not** set on deploy, so a deployed worker is fail-closed
until you wire real auth. See `packages/vertical-auth` for the OIDC composition a
vertical mounts; the kernel only ever receives the resolved `PrincipalId`.

## The shape to copy

- **Your module** ([`src/notes.ts`](src/notes.ts)) is a manifest + migrations +
  operations + the schemas the host parses them against. Every operation checks a
  permission first, reads the clock as `ctx.now()`, returns a page rather than a
  table, and emits a kernel-stamped event — the rules the platform enforces
  mechanically.
- **Parsing is the host's job.** The module hands over `operationInputs`, and the
  scope parses an invocation against them before the guards and the handler run,
  on every path in (HTTP, test, seed, schedule). Handlers do not hand-parse.
- **The worker** ([`src/worker.ts`](src/worker.ts)) bundles the modules into a
  `ScopeDO`, exports the `ControlPlaneDO`, and resolves a principal → `getScope` →
  `invoke`. Adding another engine is one import plus one entry in `MODULES` and its
  entitlement key in the seed.
- **Provisioning is two calls, not one** (K-31): `provisionScope` writes the
  directory row as `provisioning` and `activateScope` is the vertical's
  confirmation that the scope exists. `getScope` fails closed in between.

## What this example does *not* show yet

Auth. The `x-principal` dev header here is a placeholder — every demo vertical in
the monorepo is now **OIDC-only** (`docs/architecture/oidc-only-demos.md`): they
run no credential store, start a real OIDC issuer in dev, and map the
authenticated `sub` onto a scope principal. Porting this example onto that shape
is the remaining half of #983.
