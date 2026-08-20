---
'create-substrat': minor
---

The scaffold's deployed surface is the one you developed against, and it can receive
config (#799).

**Two entrypoints, two APIs.** `server.ts` mounted ~20 named REST routes; `worker.ts` —
the one that actually deploys — mounted `/api/me` and `POST /api/invoke`. Nothing was
wrong with either alone. What was wrong is that a scaffolded project's local surface was
not its deployed surface, and nothing said so until deploy: build a UI against the dev
routes, ship it, and it talks to an API that isn't there. The failure is silent in the
direction that matters, arriving after the route names are load-bearing.

The fix already existed in the repo. `src/routes.ts` is now one route table with a
`mountApi(app, resolveStub)`, and both entrypoints mount it — callout's shape, and its
stronger claim: the SAME vertical surface runs on both adapters, so the two cannot drift.
Each entrypoint keeps only what is genuinely its own — building a host, resolving a
caller, and its one auth-shaped route. `/api/cast` (the dev persona picker) and `/api/me`
stay split on purpose; that asymmetry is how a client tells a dev server from a
deployment, and it is now written down rather than incidental. `/api/invoke` moved into
the shared table: it is the useful generic escape hatch and read as a Cloudflare-only
affordance.

**One error vocabulary.** The table's `onError` is built on `classifyError`
(`@substrat-run/vertical-host`) — the same function `mountPlatformSurface` uses. This
matters more than it looks: Hono keeps only the last-registered `onError`, so in the
worker the platform's envelope replaces the table's. That is safe precisely because both
classify through one function. It also retires the starter's hand-rolled
`/invalid transition|immutable|already/` regex in favour of the #113 taxonomy, so a
refusal that declares what it is outranks a guess about its prose.

**`onConfigure`, the seam that was missing.** The template passed six hooks to
`mountPlatformSurface` and not this one, so a scaffolded vertical answered **501** to
per-instance config for its whole life. Concretely: the dashboard delivers a scope's
Identity choice (the `substrat:auth` entry) over exactly that route, so saving an issuer
in Settings landed in the account's record and never reached the running app. The
dashboard was honest about it (`delivered: false`) — but the remedy is a new version
pushed and promoted, and nobody knows they need one until they are standing at the wall.
It also taught at least one agent that the platform was stricter than it is: finding no
delivery seam in its own worker, it concluded OIDC wiring was create-time and permanent.

Deliveries now land in `src/config-do.ts`, a per-tenant DO whose `scope_config` table
matches `@substrat-run/vertical-auth`'s `IdentityDO` exactly — so a project that later
adopts vertical-auth for real logins swaps the binding and keeps its rows. They are read
back through `resolveScopedEnvSpec`, which is the half that keeps the hook from being
write-only: an `envSpec` default rides as a worker binding shared by every install of one
serving script, so reading `env.FOO` directly always yields the shared default no matter
what a tenant saved. A declared `SHOP_NAME` (manifest + `substrat.envSpec`) makes that
demonstrable rather than theoretical.

The starter still ships no auth — the seam is deliberate — so `substrat:auth` is stored,
typed and surfaced rather than acted on. What changes is the failure: a 401 now names the
situation instead of being bare, because "an issuer is configured and every request is
still 401" is the case that reads as a platform bug and isn't.

**Found while verifying, and worth recording.** `export const AUTH_CONFIG_KEY` on
`worker.ts` made workerd refuse to boot — every named export of the entry module must be a
handler or a Durable Object class. `tsc` was clean and all nine scenario tests passed. The
constant moved to `config-do.ts`. That is the same defect class this changeset fixes,
reproduced on the fix for it, and it is what #797 exists to catch: the template is not a
workspace member, so no repo gate builds the artifact we hand users. Verification was a
real scaffold — `npm install` from the registry, both hosts driven over HTTP.
