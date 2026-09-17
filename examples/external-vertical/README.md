# external-vertical

A Substrat vertical built **from published packages**, standing in for a repo
outside this monorepo. It depends on `@substrat-run/*` at real semver ranges (no
`workspace:*`) and is **not** a workspace member — installing here resolves
everything from npm, exactly as a real external project would.

That is the whole job of this directory: it is the one place in the repo where
"the published packages still compose into a working vertical" is a thing you can
check rather than assume. No workspace link stands in for a registry resolve, so
the pins below have to be maintained — a caret range on a `0.x` package pins the
minor, and a stale one silently installs code a release has moved past.

## What it is

One deployable Cloudflare Worker that composes:

- `@substrat-run/kernel` + `@substrat-run/contracts` — the runtime and vocabulary
- `@substrat-run/adapter-cloudflare` — the Durable-Object scope host
- `@substrat-run/vertical-auth` — the OIDC relying party (login, callback,
  session cookie); `@substrat-run/dev-issuer` is the local issuer it signs in at
- `@substrat-run/engine-workorder` — a **published engine**, proving engines
  resolve and bundle from npm
- [`src/notes.ts`](src/notes.ts) — **your own module**, a minimal one

It is self-contained: it embeds its own control plane and seeds its own tenant and
scope. Registering into a separately-deployed shared control plane is what
`substrat push` does, and this example deliberately does not.

## Run it

```sh
npm install        # or pnpm install --ignore-workspace, from inside this repo
npm run dev        # the dev issuer on :8879 + wrangler dev on :8787 — no Cloudflare account needed
```

Then **open <http://localhost:8787> in your browser**: a tiny built-in page lets
you *Seed world*, **Sign in**, add notes, and see them — driving the same API
below. Signing in is a real OpenID Connect round-trip to
`@substrat-run/dev-issuer`, whose only shortcut is that it lists names instead of
asking for a password. Pick **Ada** (a member) to write notes, or **Bo** (signed
in, holds no role) to see the permission check refuse.

> **Running from inside this repo:** `examples/` is deliberately **not** a pnpm
> workspace member, so a plain `pnpm install` here would target the whole
> monorepo. Use `pnpm install --ignore-workspace` to install it standalone from
> the registry, the way a real external checkout does. A genuine checkout outside
> the repo just runs `npm install`. Either way the lockfile it writes is
> gitignored: pinning the resolution is exactly what this example must not do.

> **npm is the stricter check of the two.** pnpm downgrades an unmet peer to a
> warning; npm refuses to install at all. So a peer range that has gone stale here
> — `@cloudflare/workers-types` against whatever major current `wrangler` wants —
> is invisible under pnpm and a hard failure under npm. Run the npm one.

### Or drive the API directly

```sh
# provision the world once (tenant → entitlements → scope → activate → role → identity links)
curl -s -X POST http://localhost:8787/seed

# a token for a persona, minted by the dev issuer — impersonation lives at the
# issuer, never in the vertical
T=$(curl -s -X POST localhost:8879/dev/token -d '{"sub":"dev|ada"}' | jq -r .access_token)
A="authorization: Bearer $T"
curl -s -H "$A" http://localhost:8787/api/me
curl -s -X POST -H "$A" -H 'content-type: application/json' \
  -d '{"text":"first note"}' http://localhost:8787/api/notes
curl -s -H "$A" http://localhost:8787/api/notes
curl -s -H "$A" http://localhost:8787/api/workorders   # [] — engine registered
```

Both list routes are **paged**. The body is the entries and the walk rides in a
`Link` header, so a client follows a URL rather than assembling a cursor:

```sh
curl -si -H "$A" 'http://localhost:8787/api/notes?limit=2' | grep -i '^link:'
# link: <http://localhost:8787/api/notes?limit=2&cursor=01M1…>; rel="next"
```

No `rel="next"` means the walk is over.

## Deploy it

```sh
npm run cf:deploy   # needs a Workers Paid plan (Durable Object SQLite)
```

The four OIDC settings are passed by the `dev` script only, so a deployed worker
authenticates nobody until you give it an issuer — every `/api/*` call answers
401 and says which settings are missing:

```sh
npx wrangler secret put OIDC_ISSUER          # your issuer's origin
npx wrangler secret put OIDC_CLIENT_ID
npx wrangler secret put OIDC_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET       # signs the session cookie
```

`POST /seed` links the dev cast **only when `OIDC_ISSUER` is a local origin**:
anyone can pick those names at the dev issuer, so linking them against a real
issuer would hand principals to whoever it happens to call `dev|ada`. Against a
real issuer, link your own subjects with `host.admin.linkIdentity`.

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
  `ScopeDO`, exports the `ControlPlaneDO`, and resolves the caller → `getScope` →
  `invoke`. Resolving the caller is two steps, the same two every OIDC-only
  vertical takes: verify the request against the issuer to get a `sub`, then ask
  the identity directory which principal that subject is. Adding another engine is one import plus one entry in `MODULES` and its
  entitlement key in the seed.
- **Provisioning is two calls, not one** (K-31): `provisionScope` writes the
  directory row as `provisioning` and `activateScope` is the vertical's
  confirmation that the scope exists. `getScope` fails closed in between.

## Keeping it alive

This example is only worth having if it still installs. The pins in
`package.json` are literal semver ranges, `catalog:` does not reach here, and no
PR gate resolves them. The `external-vertical` job in
[`.github/workflows/scaffold.yml`](../../.github/workflows/scaffold.yml) runs the
three commands below against the registry after every release and weekly, so a
pin that no longer installs or compiles goes red there. It does not catch a pin
that is merely *behind*: a caret on a `0.x` package pins the *minor*, so a stale
pin installs an older release rather than failing. To check by hand:

```sh
npm install                                # must not error on a peer
npm run typecheck                          # the published surfaces still compile
npm run dry-run                            # …and still bundle into a worker
```

If `npm install` refuses on a peer, or `typecheck` reports a surface that moved,
that is the example doing its job: it is the earliest place an external consumer's
breakage shows up.

## What this example does *not* show

The per-tenant `IdentityDO` from `@substrat-run/vertical-auth`, with its
owner-claim and invite flows. This example is self-contained and embeds its own
control plane, so that control plane's identity directory is where `sub` →
principal lives. A vertical deployed with `substrat push` keeps no control plane
and would use the `IdentityDO` instead — the auth seam in the `npm create substrat`
template's `src/worker.ts` marks where it goes.
