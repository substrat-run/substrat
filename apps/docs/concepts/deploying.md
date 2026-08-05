# The deploy model

A vertical you build on Substrat runs as a **hosted app**: one Durable Object per tenant scope,
its own SQLite, served by code you pushed. This page is the model behind getting that code from
your laptop into production and keeping it there safely — the concepts the
[deploy how-to](/guide/deploying) and the [dashboard](/platform/dashboard) both assume. The
mechanics of the `substrat` CLI live in the how-to; the *shape* lives here.

## Push vs deploy

Two distinct acts, deliberately not fused:

- A **push** uploads a version. The CLI builds your worker locally, POSTs the bundle plus a
  manifest to the control plane, and the control plane records an immutable version (a
  `deploymentRef`, a permission digest, a migration digest). A push does **not** serve anything.
- A **promotion** points a **channel** at a version and makes scopes run it. This is the deploy.

The split exists because "here is a new build" and "run this build against real data" are
different decisions with different blast radii. A push is cheap and reversible — it just adds a
version to the registry. A promotion changes what a live tenant sees.

## Admission: may this code run here?

Before a version can be promoted it must be **admitted** — the answer to *"may this code run on
our infrastructure at all?"* Admission is answered **mechanically**, by the sandbox contract: the
bundle may declare only its own durable stores (a positive binding allowlist — no
`CONTROL_PLANE`, no platform secret), it runs inside a Workers-for-Platforms isolate, and it is
held to quotas. If the bundle satisfies the contract, nothing else is in question.

**Reaching the outside world is not a binding — it is a granted capability.** The allowlist
deliberately excludes egress-shaped bindings (`send_email`, `ai`, `browser`, …): a hosted vertical
never talks to a third party by declaring a binding. When a vertical genuinely needs a platform
capability — sending transactional email, provisioning tenants — it *declares a request* in its
manifest (`substrat.sendsEmail`, `substrat.provisions`) and a **staff grant** turns it on
(`setVerticalEmailSender`, `setVerticalTenantProvisioner`). The request is refreshed on every push
and grants nothing by itself; the grant is a directory flag a push can never set or keep, so pushing
new code can never acquire authority. At runtime the platform provides the capability behind a
credential the vertical never holds — for email, a `POST /internal/email/send` relay on the control
plane that sends on the vertical's behalf and checks the grant on every call. This is why "how a
vertical gets a dependency" is: declare the request, get it granted, call the platform seam — never
bind the raw resource.

Who has to *vouch* for a version depends on who will be exposed to it (decision D-36):

- **Private vertical** (you own it, it is not listed on the marketplace). The only tenant that
  can run the code is the workspace that wrote it — you. There is no third party to protect, so
  the sandbox contract is the entire gate and a push lands **admitted automatically**. An
  auto-admission note records that no human vouched, so the platform can still tell an
  auto-admitted version from one a human reviewed.
- **Listed vertical** (published to the marketplace, so *other* tenants can install it against
  *their* data). Now a second question appears — *"may other people run this code against their
  data?"* — and that is a **human** decision. A listed vertical's pushes land **pending** for
  staff admission, and its production promotion is a staff decision too.

The human gate did not disappear; it moved to the boundary where it means something. The place a
private vertical becomes listed — `substrat publish`, the `setVerticalListed` decision — is where
a human vouches. Publishing is the checkpoint, not every push.

## The one channel: `prod`

A vertical has exactly **one channel — `prod`**: the pointer at the version its scopes serve.
There is no `dev` or `staging`. Those existed once and were *write-only* — nothing ever read or
served them (#509) — because a channel names a *pointer at code*, and an immutable version id
already does that. What a real non-production environment needs is not a second pointer but a
second **scope with data**, which is a [preview](#previews-run-a-version-against-a-copy-of-the-data).
The full argument, and how to run test / canary / release-candidate environments on previews, is
[Environments & previews](/guide/environments-and-previews).

`prod` stays a *moving target* — a [promote](/guide/deploying#promote-to-prod) re-points the prod
scope at a new version — but it is a **rebind**, not a rename: the same scope, the same data,
serving new code. For a vertical you own privately you self-serve it, so
`substrat push --promote prod` is a complete deploy and a merge-to-main workflow can be the deploy.
A prod promote re-points your live scopes in the same act — there are no *other* tenants who would
be forced into lockstep (that concern, from decision D-30, is a shared vertical's many tenants,
which a private vertical cannot have). For a shared vertical, that cascade is exactly why prod is a
fleet-wide rebind, and why bringing *one* tenant forward first is a
[per-scope bind](/guide/environments-and-previews#canary-pinned-tenants-per-scope-rollout), not a
channel.

Two things a promotion always respects:

- **The surface checkpoint.** A promotion whose **permission** or **migration** digest differs
  from what is live is refused until the diff is acknowledged. This is the same two-human-
  checkpoint discipline the kernel applies to [modules](/concepts/modules#two-human-checkpoints),
  applied at the deploy boundary — with the owner as the human at their own checkpoint.
- **Channel history.** Every promotion appends a row: what went live, what it replaced, who did
  it, and exactly when. That history is the dashboard's rollback picker, and each timestamp is
  the instant a point-in-time rewind would restore the data to.

## In-place updates: data carries forward

The property that makes "promote prod from a laptop" safe is that a vertical serves **in place**
(decision D-37). A version update is *not* a rebind to fresh, empty storage:

- A prod promote re-uploads the promoted bundle onto the vertical's **one stable serving
  script**. The scope's Durable Object and its SQLite **stay put** — data does not move.
- Because the data is still there, the kernel's append-only **migrations run forward against
  production data**, exactly as designed. This is the mechanism the whole migration model is
  built around; before in-place serving it never actually ran in production.
- Secrets survive the deploy.

A version is badged **code-only** or **schema-change** at publish, so you know whether a promote
touches the schema. A code-only update just re-points; a schema-change update runs migrations, so
it wants its migration diff acknowledged first.

## Previews: run a version against a copy of the data

Before a promotion whose *migrations* changed, you often want to see the new version run against
real-shaped data **without** touching production. Substrat can do this because the scope-host
contract already runs identical module code on two adapters — so a **preview** is a **fork** of a
scope's data bound to the new version, reachable at its own URL.

The governing law is that [migrations are forward-only](/concepts/snapshots): a snapshot taken
today (at prod's migration frontier) bound to *today's or a later* version rolls its migrations
forward on the copy — rehearse the new version against real-shaped data, throw the fork away if
it breaks, and prod never saw it. The inverse — pointing *old* code at *today's* data across a
schema change — is invalid, because you cannot un-run a migration. So the rollback strategy is
**fork-before-you-promote**: snapshot right before binding the new version, and a bad version
leaves the prior one still runnable at its correct frontier. A fork is a governed dead end — the
export copies the kernel spine too, so no connector, cron, or billing consumes from a preview —
and preview URLs are non-public, gated code running against real-shaped data. The everyday shape
of all this — test copies, fearless upgrades, real data pulled to a laptop — is
[snapshots & test copies](/concepts/snapshots).

## Backup, restore, and backout

Because every app is one scope with its own database, recovery is a per-tenant primitive, not an
environment-wide runbook — one tenant's rewind is a clean, self-contained blast radius.

- **PITR rewind — the first-hours backout.** Right before an upgrade migrates, the scope DO
  bookmarks the instant (Durable-Object point-in-time recovery, ~30 days of history). If a
  promotion goes wrong, an **audited rewind** rolls the scope's data back to that bookmark,
  time-boxed to **~24h** unless forced. A rewind is a *destructive, in-place* rollback of that
  one DO — the opposite lever to a fork, which is a non-destructive copy. It rewinds the whole
  database, so a stale bookmark is refused rather than silently skipped. One sharp edge: data and
  version binding live in different DOs, so rewinding *past a bad migration* means also rebinding
  the version — two coordinated rewinds, no atomicity between them.
- **Backup / restore — the considered path.** `substrat scope restore` loads a backup into an
  existing hosted scope, replacing its data — a pulled `.sqlite`, a local adapter-sqlite scope
  file, or a dump. This is the deliberate recovery when a time-boxed rewind is not the right tool.
- **Legacy adoption.** A scope that predates the stable serving script hops onto it once with
  `adopt-serving` (export → restore → flip, data-first), so future promotes stop stranding its
  data.

## The whole shape

Push uploads a version; admission asks *may this run here* (automatic when you are the only tenant
exposed, staff when you list it); promotion points a channel and serves **in place** so data
carries forward across every update; previews rehearse a risky version against a fork of real
data; and PITR rewind plus backup/restore are the backout. The staff human gate lives at
**publish** — the moment other tenants can run your code against their data — and nowhere else in
the loop.

See also: [Deploying a vertical](/guide/deploying) (the how-to), [Snapshots & test
copies](/concepts/snapshots), and [The platform layer](/concepts/platform).
