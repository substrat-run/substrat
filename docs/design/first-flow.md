---
status: historical
layer: plan
description: The first end-to-end flow. Milestone completed.
---

# The first end-to-end flow — deploy and manage an external vertical

**Status:** **complete** — the milestone landed; production runs it. A milestone plan, not a decision — it commits to a *walking
skeleton*, not to the scaling shape. Slices 1 and 2 are done; the slice-4 connect seam and
slice-3 staff auth are built and verified locally (see §4 Progress). What remains is the
Cloudflare-deployed join: the same seams wired into deployed workers and actually shipped.
Supersedes nothing; the choices it defers (facets vs N-deployments, git-hook vs CLI
trigger, custom hostnames) stay open.
**What this is:** the thinnest sequence of work that lets someone build a vertical in a
repo *outside* this monorepo, deploy it, watch it register itself with a shared control
plane, and manage it — suspend, entitle, review permissions — from the console. It is
first at this point that we know the platform is real.

Read alongside [control-plane](control-plane.md) (the directory surface this makes shared
and deployed), [kernel-design](kernel-design.md) §5.5 (deployment topology) and §9 (the
published packages), and [generated-verticals](generated-verticals.md) §2 (the loop this
is the manual, trusted-author version of).

**Sequencing, stated first:** this milestone deliberately proves the loop with **one
hand-deployed vertical against one shared control plane**. It does *not* answer "how does
the control plane orchestrate N deployments" ([kernel-design](kernel-design.md) open
question 9) or which scaling shape wins (§6.3 there). Those are only answerable once a
single instance of the loop is green, and nothing here forecloses them.

---

## 1. The goal, as one testable sentence

> An external git repo runs `pnpm add @substrat-run/*`, writes a worker, and
> `wrangler deploy`s it. On first boot the vertical registers a tenant and scope with a
> **separately deployed** control plane. The console — pointed at that same control plane,
> behind real auth — shows the new scope, and a suspend from the console fails the
> vertical's next operation closed.

When that sentence is a passing test, the milestone is done. Everything below exists to
make it true.

## 2. What already exists (do not rebuild)

The npm half of "build outside the repo" is real today:

- **Runtime packages are published at 0.4.0**: `@substrat-run/kernel`, `contracts`,
  `adapter-sqlite`, `adapter-cloudflare`. **Engines are published**: `engine-workorder`
  0.3.0, `engine-protocol` 0.3.0, `engine-invoicing` 0.2.0.
- The Cloudflare adapter exports exactly the worker primitives —
  `defineScopeDO`, `ControlPlaneDO`, `CloudflareScopeHost`
  ([adapter-cloudflare/src/index.ts](../../packages/adapter-cloudflare/src/index.ts)).
- A working reference wiring exists in
  [demos/callout/src/worker.ts](../../demos/callout/src/worker.ts): Hono API →
  `defineScopeDO(MODULES)` + `ControlPlaneDO` + `CloudflareScopeHost` + Better Auth (D1).
- The control-plane API router is web-standard and already documented as mountable in a
  Worker ([control-plane-api/src/api.ts](../../packages/control-plane-api/src/api.ts),
  the header comment on the transport seam).
- The console builds a `dist` and is a thin client over that router
  ([apps/console/src/lib/api.ts](../../apps/console/src/lib/api.ts)).

## 3. The one gap that matters: two disjoint control planes

Today the vertical and the console each own a *separate* directory, and neither can see
the other:

- In the demo, `ControlPlaneDO` lives **inside the vertical's own worker**
  ([worker.ts](../../demos/callout/src/worker.ts)), and the vertical seeds its tenant/scope
  into that embedded directory via its own `/api/seed`.
- The console talks to the control-plane-api **dev server**, which stands up its **own**
  `SqliteScopeHost` in a temp dir with a hand-seeded fake fleet, behind
  `UNSAFE_devPlatformActorAuth` bound to `127.0.0.1`
  ([control-plane-api/dev/server.mts](../../packages/control-plane-api/dev/server.mts)).

So the console renders a mock fleet with no connection to any deployed vertical.
"Connect it to substrat" has no target. **The milestone is, in essence, making one
control plane that both sides share.**

---

## 4. The slices

Four slices, ordered so each is independently mergeable and leaves the tree green. Slice 1
is the foundation; 2 and 3 can proceed in parallel once it lands; 4 is the join.

**Progress:**

- **Slice 1 — done.** `@substrat-run/control-plane-api` is published; `apps/control-plane`
  is the deployable worker over `ControlPlaneDO`.
- **Slice 2 — done.** `examples/external-vertical` builds a vertical from published
  packages (disconnected from the workspace), verified as a clean external install.
- **Slice 4 seam — built and prototyped locally.** `ControlPlaneClient` (the vertical side
  of the connect seam) and the demo's connected mode land the registration + remote-gating
  semantics; see the note under Slice 4.
- **Slice 3 auth — built and verified locally.** Real staff sign-in (Better Auth, swappable
  for AuthHero) with a `sessionPlatformAuth` seam + `staffAllowlist`; the console has a login
  screen and session-based calls. What remains is the deployed composition root + Pages
  deploy; see the note under Slice 3.
- **Bonus (not a slice): the local stack.** `pnpm dev` co-locates everything on one SQLite
  dir for a fast loop; `pnpm dev:connected` runs the *faithful* topology — a separate
  control plane, a connected vertical, and the console — locally.

### Slice 1 — A deployable, shared control plane

**Why first:** it is the shared directory both the vertical and the console point at.
Nothing downstream is real without it.

- **Publish `@substrat-run/control-plane-api`.** It is marked public but returns E404 on
  npm — the router an external repo and the console both need is currently unreachable.
  Add it to the changeset release like its siblings (it is already in the `fixed` group in
  [.changeset/config.json](../../.changeset/config.json)).
- **Hoist `ControlPlaneDO` into its own deployable worker** fronting the control-plane-api
  router. This is a new small app (`apps/control-plane` or `packages/control-plane-worker`)
  whose `wrangler.jsonc` binds one `ControlPlaneDO` and mounts `createControlPlaneApi`.
  The router already assumes an out-of-band transport, so this is wiring, not redesign.
- **Keep the DO the single source of truth.** The dev server's `SqliteScopeHost` stays as
  the *local* backing (fast console dev, no account); the deployed worker uses the DO. Same
  router, two hosts — the split the transport seam was built for.

**Definition of done:** `wrangler deploy` stands up a control-plane worker on a
`workers.dev` URL; `curl -H '<dev-actor>: …' …/tenants` returns `[]`; `POST /tenants`
persists across a cold DO.

### Slice 2 — An external-repo template

**Why:** it is the "build an app outside this repo" half made real and repeatable, and it
is the artifact the whole flow is demonstrated *from*.

- **Replace the `create-substrat` placeholder** ([index.js](../../packages/create-substrat/index.js))
  with a real scaffold, or — cheaper first step — commit a standalone example repo
  (`examples/external-vertical`, its own `package.json`, **no `workspace:*`**, real semver
  ranges on the published packages).
- The scaffold is [demos/callout/src/worker.ts](../../demos/callout/src/worker.ts) stripped to a
  minimal vertical: one trivial module, the three published engines optional, Better Auth
  wired, `wrangler.jsonc` with the two DO bindings.
- **Prove it builds against the registry, not the workspace** — CI installs it with the
  monorepo's own packages excluded from resolution, so a missing export or an unpublished
  dep fails loudly here rather than in a user's terminal.

**Definition of done:** in a clean checkout with no access to this monorepo,
`pnpm install && wrangler deploy` produces a running vertical on `workers.dev`.

### Slice 3 — Console against the deployed control plane, with real auth

**Why:** "managed via UI" is only true if the console reads the *shared* directory, not a
local mock, and only safe if it is not the `127.0.0.1` unsafe stub.

- **Point the console at the deployed control-plane URL** (build-time `VITE_` config;
  default stays the local dev proxy so in-repo dev is unchanged).
- **Replace `UNSAFE_devPlatformActorAuth`** with a real `authenticate` on the deployed
  worker that resolves a `PlatformActor` from a real session. Reuse the Better Auth seam
  the vertical already runs; the console is a platform-tenant surface, so its principals
  are platform staff, not tenant users. control-plane.md §6 ("auth gates *exposing* the
  console") is the spec this satisfies.
- **Deploy the console** (Cloudflare Pages, same path as
  [apps/docs](../../apps/docs/package.json)'s `deploy` script).

**Definition of done:** the deployed console lists the tenants that exist in the deployed
control plane, requires a real login, and refuses unauthenticated requests.

**What was built (staff auth, locally):** the real `authenticate` is
`sessionPlatformAuth(readSession, resolveActor)` in `@substrat-run/control-plane-api`,
split so the **auth provider** and the **staff roster** are independent — `readSession`
wraps the provider (Better Auth today), `staffAllowlist` decides who is staff and under
which actor id. The standalone control plane (dev server) mounts Better Auth at `/auth/*`
and uses it; the console gained a real sign-in screen and session-based API calls (no
dev-actor header). Verified end to end: the console refuses `/tenants` without a session,
sign-in succeeds, and the fleet then loads. `pnpm dev:connected` runs this; the co-located
`pnpm dev` still uses the header stub for the quick path (`VITE_DEV_ACTOR`).

**Swap to AuthHero later:** by design, only `readSession` changes — the router, the
allowlist, the console's login calls, and the `PlatformActorAuth` seam all stay. Better
Auth is "for now."

**Gap surfaced — the vertical isn't staff.** Making the control plane require a staff
session broke the *vertical's* registration (slice 4), because a connected vertical
authenticates as a **service**, not a staff member (open decision 2). Locally the control
plane accepts a staff session (console) OR the dev-actor header (the vertical's service
call), session-first; in production the vertical uses a real service credential and the
header path is gone. Deciding that credential (a signed service token / a privileged
binding) is its own step.

**Still remaining for the deployed DoD:** wire the same Better Auth (on D1) into the
deployed `apps/control-plane` worker, point the console's `VITE_` config at the deployed
URL, and deploy the console to Pages. The auth *model* is done; this is composition-root +
deploy.

### Slice 4 — The vertical registers itself, and the console can bite it

**Why:** this is the join — the step that makes it *one* platform instead of two apps that
happen to share a schema.

- **On first boot the vertical registers with the shared control plane** instead of
  seeding an embedded one: create tenant → grant entitlements → provision scope, via the
  deployed control-plane-api (or a privileged binding to it). This replaces the demo's
  self-contained `/api/seed`. This is the concrete meaning of "connect it to substrat."
- **The vertical reads entitlements and scope status from the shared directory**, so a
  console-side suspend or entitlement revocation actually changes what the vertical's next
  operation is allowed to do. (The kernel already fails closed on a suspended scope; the
  work is making the vertical consult the *shared* directory rather than its local copy.)

**Definition of done:** the §1 sentence passes as an automated test — deploy vertical,
see scope in console, suspend from console, next vertical operation returns denied.

**What was built (the seam):** `ControlPlaneClient` in `@substrat-run/control-plane-api`
is the vertical side — it registers (tenant → entitlements → scope) into a separately-run
control plane over HTTP and exposes `assertScopeActive`, a gate that fails closed exactly
as the kernel's `validateScopeAccess` does (tenant-level cascade included, not just
per-scope). The demo's `server.ts` uses it in *connected mode* (`CONTROL_PLANE_URL` set):
it mirrors its seeded directory into the shared plane and calls the gate before every
`getScope`. Proven locally across two processes — a `control-plane-api` server, a connected
vertical, and the console pointed at that plane — where a console suspend fails the
vertical's next request closed. Covered by an automated test
([client.test.ts](../../packages/control-plane-api/test/client.test.ts)) that exercises
register → scope-suspend → tenant-cascade → unreachable, and runnable with
`pnpm dev:connected`.

**Gap this surfaced — role/grant writes are not on the HTTP surface.** `createControlPlaneApi`
deliberately exposes tenant/scope lifecycle and entitlements but *not* `defineRole`/
`assignRole`/`grant` (control-plane.md §4.5 — permission writes are the human checkpoint,
D-22/D-29). So a connected vertical can register lifecycle but cannot push its permission
model to the shared plane. The prototype keeps that split: **lifecycle and entitlements are
remote-authoritative; roles stay local.** Making a vertical's roles reviewable-then-shared
(the permission-diff pipeline over the wire) is its own decision, not something slice 4
should have smuggled in through a convenient verb.

**Still remote-only for the deployed case:** the Cloudflare vertical embeds its own
`ControlPlaneDO` — pointing it at a *remote* control plane instead is the adapter-level
version of this seam, deferred with Slice 3.

---

## 5. Non-goals (explicitly deferred, so the skeleton stays thin)

- **The scaling shape.** One vertical, one control plane. Facets-as-generic vs
  N-deployments ([generated-verticals](generated-verticals.md) §6.3) is untouched.
- **The deploy *trigger*.** `wrangler deploy` by hand is the trigger for this milestone.
  Still true, with the target now named: D-34 puts the orchestration layer — *we* deploy,
  with *our* credentials — as the next step. That layer is now designed in its own RFC,
  [orchestration](orchestration.md), which commits to **Workers for Platforms dispatch
  namespaces** as the reach mechanism (K-28) rather than the ordinary-upload path, because
  the ordinary path leaves the router's reach on static bindings and so redeploys the
  platform on every push. Git-hook-on-branch and a `substrat` CLI push are ergonomics
  layered on that route, and the earlier analysis rules out an *untrusted* zip/CLI path
  regardless ([generated-verticals](generated-verticals.md) §1).
- ~~**Custom hostnames.**~~ **Built** (K-26/K-27, control-plane.md §4.7). The map is
  `hostname → (tenant, scope, vertical, surface, region)` — `surface` because one scope
  fronts more than one app, which §5.5's original tuple could not say — and a single
  environment-wide router resolves it and dispatches over a service binding. What
  remains deferred is hostname *provisioning*: DNS validation and certificate issuance
  ride Cloudflare for SaaS and are not wired, so bindings are activated by hand.
- **Billing/meters.** Out of scope per D-30 ("meter, don't bill"), and nothing here needs
  them.

## 6. Open decisions surfaced by this plan (not blockers for slice 1)

1. **One global control plane or per-jurisdiction?** The skeleton is single-global. K-7's
   per-jurisdiction DO ids mean the real answer is likely regional, but that is a slice-4+
   concern.
2. **How does the vertical authenticate *to* the control plane when registering?** A
   privileged service binding (the K-8 shape) vs an out-of-band admin credential. Decide
   during slice 4.
3. ~~**Does registration belong in the vertical at all?**~~ **Answered: pull (K-31).**
   Control-plane-driven, because only the vertical can create a usable scope DO — the DO
   class bundles the modules and lives in the vertical's deployment, so the control plane
   must ask it, and once that call exists push is a second way to do the same thing.
   Self-serve needs it regardless: a customer creating an instance is a decision the
   vertical cannot learn about on its own. Push survives as a gated dev affordance.

   Note the half of this the skeleton got wrong: it said push could "invert later without
   changing the directory contract". The contract does survive — the *authority* model
   does not, and inverting it after customer code is running is a migration.

## 7. Definition of done for the milestone

The §1 sentence is an automated end-to-end test that a CI job runs against real deployed
workers (or `wrangler dev` instances of all three: control plane, vertical, console). When
it is green, we have — for the first time — evidence the platform's whole value
proposition holds end to end, and the deferred questions in §5 become real, scoped work
instead of speculation.
