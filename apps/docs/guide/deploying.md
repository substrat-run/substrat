# Deploying a vertical

[Running locally](/guide/running-locally) ends on a promise: the SQLite adapter you run on
your laptop and the Cloudflare adapter you deploy on are the same kernel above
[the scope-host contract](/concepts/scope-host) — *only the composition root changes*. This
page is how you cross that gap. The tool is the **`substrat` CLI**, and the shape of the
crossing is two ideas: a **push** uploads a version; a **promotion** points the `prod` channel at
it and makes scopes serve it. For a vertical you own, both are yours.

The model this page assumes — push vs deploy, admission, the one `prod` channel, in-place updates,
previews, backout — is written up conceptually in [the deploy model](/concepts/deploying). For
non-production environments (test, canary, PR previews) see
[Environments & previews](/guide/environments-and-previews). This page is the how-to.

## Push is not deploy — but promotion is yours

The single idea to hold onto:

> A push uploads a version; it does not serve. A **promotion** points the `prod` channel at a
> version and makes scopes run it. For a **private** vertical — one you own, not listed on the
> marketplace — a push lands **admitted** automatically and you promote `prod` yourself. So
> `substrat push --promote prod` is a complete deploy, and merge-to-main can be the deploy.
> (`prod` is the *only* channel — a test or preview environment is a
> [scope with data](/guide/environments-and-previews), not a second pointer.)

There are two separate questions hiding in "can this go live", and Substrat answers them at
two different boundaries (decision D-36):

- **"May this code run on our infrastructure?"** — answered **mechanically** by the
  [sandbox contract](https://github.com/substrat-run/substrat/blob/main/docs/design/self-serve-deploy.md):
  the declared bindings, Workers-for-Platforms isolation, and quotas. This is **admission**,
  and for a private vertical the contract is the whole answer, so a push is admitted the
  moment it validates (an auto-admission note records that no human vouched).
- **"May *other tenants* run this code against *their* data?"** — a human decision, and it
  only arises when you **publish** a vertical to the marketplace. That is where the staff
  gate lives now: `substrat publish` (the `setVerticalListed` decision) is a human vouch, and
  from then on that vertical's pushes land **pending** and its prod promotion is a staff
  decision again.

A private vertical has exactly one tenant exposed to its code — the workspace that wrote it —
so there is no one to protect from an unvetted bundle but yourself, and you are the human at
your own checkpoint. This is still the same [two-checkpoint
discipline](/concepts/modules#two-human-checkpoints) that governs migrations and permissions:
a promotion that changes the permission or migration surface is refused until you acknowledge
the diff (`--ack-permissions` / `--ack-migrations`).

One credential principle underpins all of it: **the author never holds a Cloudflare token.**
The control plane holds the Workers-for-Platforms credential and does the upload; the CLI
builds locally and POSTs a bundle. (Decision D-34.)

## Install

The CLI is published to npm as [`@substrat-run/cli`](https://www.npmjs.com/package/@substrat-run/cli) (Apache-2.0):

```bash
npm install -g @substrat-run/cli    # or: pnpm add -g @substrat-run/cli
```

That gives you the `substrat` bin. Inside this monorepo it is also wired at the root as
`pnpm substrat`, so the examples below work either way.

## Sign in — `substrat login`

```bash
substrat login
```

The default is a **browser loopback login**: the CLI starts a one-shot server on `127.0.0.1`,
opens your browser to the control plane's CLI broker (`{cp}/auth/cli`), which signs you in
through [AuthHero](/concepts/identity) and redirects back with a PKCE-bound `code`. The CLI
exchanges the code for a session token and stores it in `~/.substrat/config.json`. The token
never transits a URL — only the code does — and the loopback server accepts exactly one callback,
then closes.

For CI, where there is no browser, the credential is a **tenant-scoped push token**
(`spt1.…`) in the `SUBSTRAT_SERVICE_TOKEN` environment variable — the dashboard's one-click CI
setup mints and installs it for you ([below](#deploy-from-ci)).

Either way, auth resolves in this order at push time: explicit `--token` /
`SUBSTRAT_SERVICE_TOKEN` → a stored browser session → a stored service token. Two consequences
worth knowing:

- An **exported `SUBSTRAT_SERVICE_TOKEN` wins over a fresh `substrat login`** — the session is
  ignored. The CLI warns when this happens; unset the variable to use the session, or pass
  `--token` to make the override explicit.
- The control-plane URL resolves `--cp` → `SUBSTRAT_CP_URL` → the stored config, and it must be
  the **API base** — `https://console.substrat.net/api`, not the console page. Getting HTML
  where JSON was expected is the symptom, and the CLI's error message names it.

You are always authenticated **as yourself** — a push is attributable to the human or service
that ran it, never a hand-picked actor.

## Your workspace

A vertical is owned by a **workspace** (a tenant), not a bare user — the same account you sign
into the [dashboard](/platform/dashboard) with. On `login` the CLI resolves which workspaces you
belong to and stores a default; `substrat whoami` prints them:

```bash
substrat whoami
# signed in as you@acme.com
#   acme-co  (Acme Co)
```

Which workspace a **push** acts for is pinned per project, not per machine: a
`"substrat": { "tenant": "acme-co" }` block in the vertical's `package.json` (the first
interactive push offers to write it for you; `--tenant` / `SUBSTRAT_TENANT` override). The
stored login default is deliberately *not* used for pushes — the first push of a slug claims it
for a workspace, and a global default silently pointing at the wrong one would claim it for the
wrong owner. You never type your workspace *into* a slug — the control plane forms the prefix
for you (next section). New here? Sign up once in the dashboard to create your workspace, then
the CLI just works.

## Ship it — `substrat push`

```bash
cd my-vertical && substrat push
```

Run it from the vertical's directory and it needs no flags: the **slug** and **name** come from
a `"substrat": { "slug", "name" }` block in `package.json` (or are derived from the package
name), and the **version** defaults to the registry's latest, patch-bumped — so you never
hand-track it. Override any with `--slug`, `--name`, or `--version`.

What you declare is **what your vertical needs from the runtime, in Substrat terms** — a
`runtimeNeeds` block in the same `substrat` section. You never write Cloudflare deploy config;
the CLI derives it at push time:

```json
{
  "substrat": {
    "slug": "helpdesk",
    "runtimeNeeds": {
      "entry": "src/worker.ts",
      "needsNodeCompat": true,
      "build": "pnpm --dir app build && node scripts/gen-assets.mjs",
      "stores": [
        { "binding": "SCOPE", "class": "ScopeDO" },
        { "binding": "AUTH", "class": "IdentityDO" }
      ]
    }
  }
}
```

- `entry` — your worker's entry module.
- `needsNodeCompat` — set it if you use Node built-ins at runtime (Better Auth does).
- `build` — an optional command to run before bundling (an SPA build, asset generation).
- `stores` — your vertical's **own** durable state classes and the binding each is reached
  through (`env.SCOPE`). This is the whole vocabulary on purpose: the sandbox contract refuses
  everything except your own stores anyway, so there is nothing else to say. The compatibility
  date is the **platform's** runtime baseline — you never pick it.

(If you already maintain a `wrangler.jsonc` — the demos in this repo do, for local
`wrangler dev` — the CLI still reads it when no `runtimeNeeds` block is present. When both
exist, `runtimeNeeds` wins.)

The same `substrat` block also carries your **install spec** — what the dashboard grants and
renders when someone installs your vertical, no catalog edit needed:

- `entitlements` — the full entitlement set an install grants the installing tenant (your
  own SKU flag plus any engine you compose, e.g. `["helpdesk", "workorder"]`). **Absent, the
  platform derives your slug** — so a vertical whose module gates on
  `entitlementKey: '<slug>'` (the convention) installs entitled to itself out of the box.
  Declare the list explicitly the moment you gate on anything else.
- `ownerGrants` — the permissions the installing owner holds inside the fresh scope on day
  one.
- `envSpec` / `surfaces` — the install form's config fields and your declared UI surfaces.

The same block is also where you **request platform capabilities** — the things the sandbox
deliberately won't let you bind for yourself:

- `sendsEmail` — set it (`"sendsEmail": true`) if your vertical sends transactional mail
  (password resets, verification, invites). You get **no** `send_email` binding: a dispatch
  script can't hold one, and the sandbox refuses it. Instead the platform sends on your behalf
  through a relay, and your code just uses the ordinary `EmailTransport` seam — the auth-server's
  Better-Auth `sendResetPassword` callback is the reference. The declaration is a **request**;
  it does nothing until a staff member grants the `emailSender` capability in the console.
- `provisions` — the verticals your manager app creates tenants of (the tenant-provisioner
  request), turned on the same way (`setVerticalTenantProvisioner`).

A capability request is refreshed on every push and confers nothing by itself; the matching
grant is a directory flag your push can never set or keep — so shipping code can never quietly
acquire outbound authority. This is the wiring model: **declare the request, get it granted,
call the platform seam — never bind the raw resource.**

Entitlements are delivered to your vertical **with provisioning** and projected locally; your
per-operation gate fails closed on anything the tenant doesn't hold. If a live install ever
ends up missing one (granted later, or repaired), the control plane re-delivers through your
`/internal/reconcile` route — part of the required `/internal` contract for hosted verticals
(`/internal/provision`, `/internal/reconcile`, `/internal/configure`, and the
snapshot/export/restore family). A vertical without `/internal/reconcile` cannot be repaired
in place.

You do **not** hand-write those routes. The whole `/internal` surface — plus the `{ error }`
response envelope the control plane relies on to read a failure — is authored once in
[`@substrat-run/vertical-host`](/reference/vertical-host) and mounted in one call:

```ts
import { mountPlatformSurface } from '@substrat-run/vertical-host';

mountPlatformSurface(app, {
  platformSecret: (env) => env.PLATFORM_SECRET,
  hostFor,                       // (env) => your CloudflareScopeHost
  roles: ROLES,
  ownerRoleKey: OWNER_ROLE_KEY,
  onProvision,                   // your pending-owner / site-registry side effect
  resolveOwner,                  // owner-of-record for a reconcile (omit ⇒ 501)
  onConfigure,                   // per-instance config store (omit ⇒ 501)
});
```

Mounting it is what satisfies the contract — the routes cannot drift out of sync or ship
without the error envelope, because there is only one copy. `create-substrat` scaffolds this
call for you; the demos (`demos/meridian`, `demos/manyfold`) are worked reference
implementations.

A push then:

1. **Builds the bundle** with `wrangler deploy --dry-run --outdir` against the derived config —
   running your `build` command first. workerd cannot bundle in the isolate, so the build always
   happens on your side; the endpoint only ever receives a *built* worker.
2. **Assembles the manifest** that travels with the bundle — your own store classes and
   bindings, the runtime baseline and flags, the entry module — from the same derived config
   the bundler consumed, so what you declared and what you shipped cannot drift.
3. **Computes digests** — manifest, permission (from the bindings), migration (from the DO
   classes) — the same digest-diff surface the checkpoints read.
4. **POSTs the bundle + manifest** to `{cp}/verticals/{slug}/deploy`, authenticated with your
   own credential.

The endpoint validates your declared bindings against the sandbox contract — a customer bundle
that tries to declare a `CONTROL_PLANE` binding or a platform secret is refused *before* it
reaches the namespace — uploads to the `substrat-verticals` Workers-for-Platforms namespace under
a `deploymentRef`, and records the version. For a **private** vertical that version lands
**admitted** (the sandbox contract is the whole gate); a **listed** vertical's lands **pending**
for staff admission. On success the CLI prints the version id, its admission state, and the
`deploymentRef`:

```
✓ pushed acme-co/helpdesk. version 01J… (0.2.1) is admitted; deploymentRef=acme-co-helpdesk-01j…
  promote it to a channel to go live (or push with --promote prod).
```

To make the same push a full deploy, add `--promote prod`:

```bash
substrat push --promote prod
# ✓ pushed acme-co/helpdesk. version 01J… (0.2.1) is admitted; deploymentRef=…
# ✓ acme-co/helpdesk → prod now points at 0.2.1
```

That is the shape the generated merge-to-main workflow uses: a private vertical's push is
already admitted, so `--promote prod` succeeds immediately and the merge *is* the deploy. (A
listed vertical's push lands pending instead, and the `--promote prod` in the same run is
refused, naming the staff gate.)

### The `<workspace>/` prefix

You push a **bare** `--slug helpdesk`; the vertical's registry id is `acme-co/helpdesk` —
your workspace slug, prepended by the control plane from your authenticated session. You never
type it. The point is that the name is unique *by construction*: every workspace can own a
`helpdesk` without a global land-grab, the same way project names are scoped to your account on
Vercel. (This prefixes only the registry id and the `deploymentRef` — never an app's hostname,
which is per *instance* and chosen when someone creates one.)

Ownership is claimed on first push and fixed there: a later push to `helpdesk` from a different
workspace is *its own* `other-co/helpdesk`, and no one else can push versions of yours.

The flip side: **the credential picks the lineage.** A workspace-prefixed `acme-co/helpdesk` and
a bare, platform-registered `helpdesk` are different verticals, even if they build from the same
repository — pushes to one never update the other. Builder credentials (your login session, a
push token) always land in your workspace's namespace; only platform staff address bare slugs.
If a vertical seems to exist twice, or a push "succeeds" but the version never shows up where
you're looking, check which lineage each side is resolving before anything else.

## Serving in place — updates carry data forward

A vertical serves **in place** from one stable serving script, and version updates carry the
scope's data **forward** (decision D-37). This is the part that makes "promote prod" safe to do
from your laptop:

- A prod promote **re-uploads** the promoted bundle onto the vertical's stable serving script.
  The scope's Durable Object and its SQLite **stay put** — data does not move, so an update is
  not a rebind-to-empty-storage.
- Because the data is still there, the kernel's append-only **migrations run against production
  data**, exactly as they were designed to. A version is badged **code-only** or
  **schema-change** at publish so you know which kind of promote you are doing; a schema-change
  promote wants its migration diff acknowledged.
- Secrets survive the deploy (`keep_bindings`).
- **Backout is a time-boxed rewind.** Right before an upgrade migrates, the scope DO bookmarks
  the instant (Durable-Object point-in-time recovery). If a promotion goes wrong, an audited
  **rewind** rolls the scope's data back to that bookmark — time-boxed to **~24h** unless forced,
  the first-hours backout. The considered, longer path is [backup / restore](/concepts/deploying#backup-restore-and-backout)
  (`substrat scope restore`). PITR rewinds the *whole* database, so a stale bookmark is refused
  where it cannot be skipped.

Legacy scopes that predate the stable serving script hop onto it once with
`substrat scope adopt-serving <scopeId>` (export → restore → flip, data-first; idempotent, and
`--vertical <slug>` backfills every scope of a vertical).

## See what you've pushed — `substrat versions`

```bash
substrat versions helpdesk
# VERSION  ADMISSION  CHANNELS      ID
# 0.2.1    admitted   prod          01J…
# 0.2.0    admitted                 01J…
# 0.1.0    admitted                 01J…
```

A bare slug again — the control plane resolves it under your workspace. The same view is in the
dashboard's **Deployments** tab (below), so you can watch admission state and channels without
the CLI. (If a prod promote's in-place serve ever failed, `versions` flags the split — the
channel points at the new version but the scopes still run the old one — as `prod(promoted)` vs
`prod(serving)`, so a stalled serve is visible rather than silently assumed live.)

## Promote to prod — `substrat promote` {#promote-to-prod}

Once a version is **admitted** — which for your private verticals is immediately — you point
`prod` at it yourself. `prod` is the only channel, so `--channel` defaults to it and you rarely
type it:

```bash
substrat promote helpdesk --version 01J… --ack-migrations
```

Promotion re-points the prod scope at a new version — a **rebind**: the same scope and data,
serving new code. For a vertical you own privately you self-serve it (there are no *other* tenants
to keep in lockstep — that concern, D-30, is a shared vertical's many tenants, which a private
vertical cannot have). Every promotion appends to the vertical's channel history — what went live,
what it replaced, who, and exactly when — which is what the dashboard's rollback picker reads and
what a rewind anchors to.

There is no `dev` or `staging` to promote to — a non-production environment is a
[preview](/guide/environments-and-previews), a scope with data at its own URL, not a second pointer
at the same code. A promote to any channel but `prod` is refused, naming the preview command.

The one thing a promote will stop for is a **changed surface**: a promotion whose permission or
migration digest differs from what is live is refused until you acknowledge the diff
(`--ack-permissions` / `--ack-migrations`) — read the diff it names first. That is the migration
/ permission checkpoint, applied at the deploy boundary.

The staff gate returns only when you **widen the audience**: `substrat publish <slug>` lists the
vertical on the marketplace, and from then on its pushes land pending and its prod promotion is a
staff decision again — because now *other* tenants can run your code against *their* data.

## Preview a pull request — `substrat preview`

Before a change is merged you can see it running — the PR's code against a **fork of your
production data**, on its own URL:

```bash
substrat preview create . --tag pr-42          # push this tree, fork prod, serve the pair
# ✓ preview 'pr-42' created → https://helpdesk-acme--pr-42.global.substrat.run
substrat preview ls                            # what's live
substrat preview delete --tag pr-42            # reap it (idempotent)
```

`create` pushes the working tree (so the version it binds is exactly the PR's code), forks
your vertical's prod scope, binds the pushed version to the fork, and mints a non-canonical
`--<tag>` hostname alongside your prod URL. Re-running the same `--tag` (what a new push to
the PR does) **rebinds the new version onto the same fork**, so successive pushes roll their
migrations forward on one copy — the rehearsal you actually want before a migration merges.
`--refresh` starts over from a clean fork of prod. Every preview carries a TTL (`--ttl 72h`
by default) so an abandoned one is garbage-collected even if it is never deleted.

This is wired into the generated GitHub workflow for you: **opening or updating a PR creates
or updates its preview and comments the URL; closing the PR reaps it.** If your vertical was
set up before previews existed, re-run the dashboard's one-click CI setup (or copy the
regenerated `.github/workflows/substrat-deploy.yml`) to pick up the PR jobs.

A preview forks *your own tenant's* scope and serves no install, so you may preview a vertical you
own whether it is **private or listed** — publishing widens who may *install* your code, not who may
preview their own pending version (#513). A vertical's *first* environment, before any prod scope
exists to fork, is `substrat preview create --tag … --empty` — a clean-room scope, no source
(#514). The one hard limit is jurisdiction: forking pins the copy's *execution*, so an `eu`/`us`
source scope is refused until Regional Services, the same residency gate as `scope pull`. The fork
carries real data and its `--<tag>` URL is non-canonical and not public — treat it as production
data.

Previews are the substrate for every non-production environment — sticky-per-PR and per-build URLs,
a long-lived test environment on a custom domain, canary rollout, a release candidate. Those
patterns, and the CI recipe that wires them, are [Environments & previews](/guide/environments-and-previews).

## Deploy from CI — the push token {#deploy-from-ci}

Your laptop authenticates with a browser login; a pipeline cannot. The CI credential is a
**tenant-scoped push token** — a long-lived machine credential, recognizable by its `spt1.`
prefix, that authenticates as a *builder for exactly one workspace*. It can do what you can do
as a builder — push, promote your private verticals (prod included), manage previews — and
nothing more: it never reaches another workspace's namespace, never admits a version, and never
promotes a **listed** vertical to prod (those stay staff decisions). It rides the same
`SUBSTRAT_SERVICE_TOKEN` variable the CLI already reads, so the workflow needs nothing special.

Two tokens deliberately do *not* fill this role: your login session is per-human and short-lived,
and the platform's internal service token is staff-equivalent — it must never land in a
customer repository (and would push to the wrong lineage anyway, per the previous section).

You rarely handle the push token yourself. The [dashboard](/platform/dashboard)'s Deployments
view has a **one-click CI setup**: connect the GitHub App, pick a repository and branch, and it

1. mints the push token,
2. writes it as the repo's `SUBSTRAT_SERVICE_TOKEN` Actions secret (before the workflow, so the
   first run already finds its credential), and
3. commits `.github/workflows/substrat-deploy.yml` — which triggers that first run immediately.

The committed workflow is the whole loop from this page: a push to the chosen branch installs
dependencies (your lockfile picks the package manager) and runs
`substrat push --promote prod` — for a private vertical, merge-to-main *is* the deploy; opening
or updating a PR creates its [preview](#preview-a-pull-request-—-substrat-preview) and comments the URL; closing
the PR reaps it. A manual copy-paste path shows the same file if you'd rather commit it yourself.

If you never connect the GitHub App — you own your CI, you are not on GitHub-hosted runners, or
you want the release-train shape instead of merge-deploys-prod — generate the same file locally:

```bash
substrat init --ci github                        # merge to the deploy branch releases
substrat init --ci github --release changesets   # only a package.json version move releases
```

Both paths render from one generator, so the committed workflow and the generated one cannot
drift. Two extras are opt-in through repository *variables* rather than a regenerated file:
`SUBSTRAT_TEST_SCOPE_ID` makes every merge rebind a
[long-lived test environment](/guide/environments-and-previews#a-long-lived-test-environment), and
`SUBSTRAT_PER_BUILD_PREVIEW` adds a frozen
[per-build URL](/guide/environments-and-previews#sticky-per-pr-and-per-build-urls) to each PR
comment alongside the sticky one. See [`substrat init`](/reference/cli#init).

One thing to know while the first run is in flight: **a vertical registers on its first
successful push**. Until then there is no version row in the dashboard to hang an error off —
if nothing appears, the place to look is the repository's Actions tab, not the Deployments view.

## Watch it in the dashboard

Everything above is mirrored in the [dashboard](/platform/dashboard)'s **Deployments** view: the
verticals your workspace has pushed, each version's admission state, and where `prod` points — with
self-serve prod promotion for a vertical you own, the channel history behind the rollback picker,
and a **Previews / Environments** surface for the non-prod work ([test env, PR previews,
canary](/guide/environments-and-previews)). Push from the CLI, manage from either.

## The whole path

**push → (auto-admitted) → promote → serve in place** — laptop to production with the author
never holding a Cloudflare credential, data carried forward across every update:

| Step | Who | Where |
|---|---|---|
| `push` a bare slug → `<workspace>/<slug>` version | you (the owner) | CLI |
| admission — automatic for a private vertical (the sandbox contract *is* the gate) | the control plane | — |
| promote `prod` (re-points your live scopes; the only channel) | you | CLI or dashboard |
| serve in place — DOs/data stay put, migrations run forward | the vertical's serving script | — |
| backout — time-boxed PITR rewind, then `scope restore` | you | CLI / dashboard |
| resolve hostname → scope → dispatch | the [router](/platform/router) | — |

When you later `substrat publish` a vertical to the marketplace, the staff gate reappears at
that boundary: its pushes land pending and prod promotion becomes a staff decision, because that
is the point where *other* tenants run your code against their data.

## Where this is going

Self-serve end to end for a vertical you own — push it, promote prod, serve in place with data
carried forward — is what ships today. The remaining evolution is on the
*publish* side: admitting an **untrusted, listed** builder's source safely — building a
customer's code in a disposable sandbox so the digest checkpoints become verified rather than
advisory — at which point even the marketplace staff gate can relax. That trust model is the
[self-serve deploy design note](https://github.com/substrat-run/substrat/blob/main/docs/design/self-serve-deploy.md).
