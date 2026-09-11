# 8. The life of one deploy

A change is committed. This chapter follows it from a laptop to a scope's database.

The decision that shapes everything here is that **uploading code and serving it are two
acts, deliberately not fused.**

## Push uploads a version. It serves nothing.

```sh
substrat push
```

The CLI builds your worker locally, then POSTs the bundle plus a manifest to the control
plane, which records an **immutable version**: a `deploymentRef`, a permission digest, a
migration digest.

That is all. Nothing is serving the new code. A push is cheap and reversible — it adds a
row to a registry. The reason for the split is that "here is a new build" and "run this
build against real data" are different decisions with very different blast radii, and
fusing them means you can only ever make both at once.

Before the upload, the CLI runs the layer rules on the **source tree** — the same
`boundary-lint` that guards this repo, now shipped as a package — plus a permission
preflight that derives your declared surface and refuses a drifted one. Both run before the
wrangler build, because a refusal is worth more in a second than at the end of a build that
was going to ship broken.

That gate is newer than it sounds, and the gap it closed is worth knowing. Until it existed,
the mechanical rules this book has been describing ran **only in this repo's CI**. A vertical
developed anywhere else was built, uploaded and admitted having been checked by nothing,
which made the rules advisory for every real customer — the opposite of the claim made for
them. There is an honest bound on the fix, too: this runs on the builder's own machine, not
platform-side over the uploaded bundle, and `--skip-lint` exists. The flag says out loud that
the push was ungated, on the reasoning that a flag which silently weakens a gate becomes the
default in somebody's CI.

## Admission: may this code run here at all?

Before a version can be promoted, it must be **admitted**, and admission is answered
**mechanically** by the sandbox contract.

The bundle may declare only its own durable stores — a positive binding allowlist. No
`CONTROL_PLANE`. No platform secret. It runs inside a Workers-for-Platforms isolate, held
to quotas. Satisfy the contract and nothing else is in question.

The allowlist deliberately excludes egress-shaped bindings (`send_email`, `ai`, `browser`).
**Reaching the outside world is not a binding — it is a granted capability.** A vertical
that needs one *declares a request* in its manifest (`substrat.sendsEmail`,
`substrat.usesModels`, `substrat.provisions`), and something outside the bundle turns it on.
The request is refreshed on every push and grants nothing by itself; no push can set the
flag it needs.

What comes back differs by capability, and the difference is worth knowing:

- **A relay**, for a capability that rides a credential. Email is the reference: the
  vertical POSTs to the control plane — the one worker holding an outbound-mail credential —
  which sends on its behalf and re-checks the grant on every call. The vertical holds no
  credential and reaches no third party directly.
- **A real binding**, for models. `substrat.usesModels` is answered with an `ai` binding
  appended *after* the allowlist check has run on the declared set, so a vertical still
  cannot declare it for itself — only be handed one. It takes both halves: the platform
  willing to bind at all, and this version having asked.

Who must **vouch** for a version depends on who will be exposed to it:

- **A private vertical** — you own it, nobody else can install it — lands **admitted
  automatically**. There is no third party to protect, so the sandbox contract is the whole
  gate. An auto-admission note records that no human vouched, so the platform can still tell
  the two apart.
- **A listed vertical** — published, so *other* tenants run it against *their* data — raises
  a second question that no contract can answer, and its pushes land **pending** for staff
  admission.

The human gate did not disappear; it moved to the boundary where it means something.
**Publishing is the checkpoint, not every push.**

## One channel, called `prod`

A vertical has exactly one channel. There is no `dev` and no `staging`.

Those existed once and were write-only — nothing ever read or served them. The reasoning
is worth keeping: a channel names a *pointer at code*, and an immutable version id already
does that. What a real non-production environment needs is not a second pointer but a second
**scope with data**, which is a preview.

A promotion re-points `prod` at a version. It is a **rebind, not a rename**: the same scope,
the same data, serving new code.

Two things a promotion always respects:

**The surface checkpoint.** A promotion whose permission or migration digest differs from
what is live is **refused** until the diff is acknowledged. This is the same two-checkpoint
discipline the kernel applies to modules, applied at the deploy boundary, with the owner as
the human at their own checkpoint.

**Channel history.** Every promotion appends a row: what went live, what it replaced, who
did it, exactly when. That history is the dashboard's rollback picker, and each timestamp is
an instant a point-in-time rewind could restore data to.

## In place: the property everything else depends on

A version update is **not** a rebind to fresh, empty storage. A promote re-uploads the
bundle onto the vertical's one stable serving script; the scope's Durable Object and its
SQLite **stay put**.

Which means:

- **Data carries forward.** Nothing moves.
- **Migrations run forward against production data**, exactly as the migration model always
  assumed. Before in-place serving existed, that mechanism had never actually run in
  production.
- **Secrets survive.**

And migrations do not run in a fleet-wide deploy step. Each scope migrates **on wake** —
the `migrateAndRecord` call from chapter 3 — inside its own serialization domain, the first
time anyone touches it after the version moved. A thousand scopes do not migrate at once;
each migrates when it is next used, and a scope that fails to migrate fails closed and
serves nothing, which is what stops it from rendering as healthy.

Stragglers are not left to chance: the platform sweep reconciles migrations as its first
phase, walks scopes that are behind the frontier, and flags the ones that keep failing.
Chapter 9 is that pass.

### A promote repairs its own installs

Each scope records the version its provision hook last ran against. Once a scope is bound to
a new version — by a promote or a per-scope bind, never by an upload alone — the platform
sweep re-runs `/internal/reconcile` on every active install whose receipt is behind.

So whatever a new release's `onProvision` mints reaches existing installs too. Which is
exactly why **that hook must be idempotent**: it runs more than once over a scope's life,
and a hook that assumes it runs at provision time only will do the wrong thing the first
time a release changes what it mints.

A version is badged **code-only** or **schema-change** at publish, so you know before you
promote whether the schema is involved.

## Previews: a fork of the data, bound to the new version

Before a promotion whose migrations changed, you want to see the new version run against
real-shaped data without touching production.

Substrat can do this because the scope-host contract already runs identical module code on
two adapters. A **preview** is a **fork** of a scope's data bound to the new version,
reachable at its own URL.

The governing law is that **migrations are forward-only**. A snapshot taken today, at
production's frontier, bound to today's or a later version, rolls its migrations forward on
the copy. Rehearse, throw the fork away if it breaks, and production never saw it.

The inverse is invalid: pointing *old* code at *today's* data across a schema change cannot
work, because you cannot un-run a migration. So the rollback strategy is
**fork-before-you-promote** — snapshot right before binding the new version, and a bad
version leaves the prior one still runnable at its correct frontier.

A fork is a **governed dead end**. The export copies the kernel spine too, so no connector,
no schedule and no billing consumes from a preview — a test copy cannot send a real invoice.
Preview URLs are non-public: gated code running against real-shaped data.

## Backout

Because every app is one scope with its own database, recovery is a per-tenant primitive
rather than an environment-wide runbook. One tenant's rewind has a clean, self-contained
blast radius.

**PITR rewind — the first-hours backout.** Right before an upgrade migrates, the scope
bookmarks the instant (Durable Object point-in-time recovery, roughly 30 days of history).
If a promotion goes wrong, an audited rewind rolls that scope's data back to the bookmark,
time-boxed to about 24 hours unless forced. It is a *destructive, in-place* rollback of one
DO — the opposite lever to a fork, which is a non-destructive copy. It rewinds the whole
database, so a stale bookmark is refused rather than silently skipped.

One sharp edge, stated because it will bite otherwise: **data and version binding live in
different DOs.** Rewinding *past a bad migration* means also rebinding the version — two
coordinated rewinds, with no atomicity between them.

**Backup / restore — the considered path.** `substrat scope restore` loads a backup into an
existing hosted scope, replacing its data: a pulled `.sqlite`, a local scope file, or a
dump. This is the deliberate recovery when a time-boxed rewind is not the right tool.

## The whole shape

Push uploads a version. Admission asks whether it may run here, mechanically when you are
the only tenant exposed and with a human when you list it. Promotion points the one channel
and serves **in place**, so data carries forward and migrations run forward against it, each
scope on wake. Previews rehearse a risky version against a fork. PITR rewind and
backup/restore are the backout.

The staff gate lives at **publish** — the moment other tenants can run your code against
their data — and nowhere else in the loop.

---

**Next:** [The two clocks →](/book/09-the-two-clocks)
