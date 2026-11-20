# 10. The life of one deploy

A change is committed. This chapter follows it from a laptop to a scope's database.

The decision that shapes everything here is that **uploading code and serving it are two
acts, deliberately not fused.**

## Push uploads a version. It serves nothing.

```sh
substrat push
```

The CLI collects a source snapshot and submits it. It does not upload a bundle it built
itself: **every release is built by the platform, from a persisted revision.** The builder
studio, a connected GitHub repository and the CLI all feed the same pipeline. The platform
installs the revision in a fresh container as an unprivileged user, with
`pnpm install --frozen-lockfile` (so a `pnpm-lock.yaml` must be committed at the source root)
and temporary repository credentials, builds it, records provenance for both the source and
the toolchain, and records an **immutable version**: a `deploymentRef`, a permission digest,
a migration digest. Promotion and rollback reuse that build output rather than building again.
A submit refused because the builder is busy is retried with backoff for several minutes
rather than failing at once.

That is all. Nothing is serving the new code. A push is cheap and reversible — it adds a
row to a registry. The reason for the split is that "here is a new build" and "run this
build against real data" are different decisions, and a mistake in the second costs far more than a mistake in the first, and
fusing them means you can only ever make both at once.

Before the upload, the CLI runs the layer rules on the **source tree** — the same
`boundary-lint` that guards this repo, now shipped as a package — plus a permission
preflight that derives your declared surface and refuses a drifted one. Both run before the
wrangler build, because a refusal is worth more in a second than at the end of a build that
was going to ship broken.

The list of things judged before anything leaves the machine has grown:

- **Your migrations are replayed through the data-loss fence** described below, using your
  vertical's own pinned kernel, so a migration that would lose populated data is refused at
  push rather than at promote.
- **A role or grant carrying a key reserved to the platform** is refused (chapter 6).
- **A Worker that imports a Node builtin its compatibility flags do not give it** is refused,
  with the import path in the message. Such a bundle passes every local check and then fails
  to start.
- **Code that names a host `substrat.outbound` does not declare** is warned about, because it
  would otherwise fail as a platform refusal at run time.

The control plane then checks the build against what you declared. Your source has been
submitted and built by this point. The control plane evaluates the built bundle in a sealed
isolate, with an empty environment, no outbound and a CPU cap, to read the migrations it
registers. A push whose declared migrations differ from the bundle's is refused before the
bundle is uploaded to the runtime and recorded as a version.

Two checks run earlier, when you write a change rather than when you push it. `substrat
changeset` computes the semver bump from the diff of the vertical's checked-in artifacts.
Removing or narrowing anything is major, adding is minor, any permission change is at least
minor and flagged, and anything it cannot rank is major. `substrat plan` renders the concept
delta a design review should read, and its `--approve` refuses when the model changed after
the person read it. Both turn a judgement an agent makes confidently, and often wrongly, into
a computation.

The push carries more than code. It flattens what each module **declares**, including the events
it emits and consumes, its schedules and its freshness expectations, onto the version's manifest.
That is what lets the dashboard later draw declared behaviour against observed behaviour
(chapter 12). It also refuses a manifest that declares a binding in the `SUBSTRAT_*` namespace,
because the platform injects names there, such as the version id every event is stamped with,
and a vertical must not be able to shadow them.

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
the human at their own checkpoint. The acknowledgement is **bound to the review it
answers**: it covers one specific set of pending migrations and one permission diff, and a
different set needs a new one. The review shows each pending migration's declared moves and
discards with their reasons, so the person is reading declarations rather than version
numbers. A deploy from CI can read the same review without promoting, with `substrat promote
--review-only`, which prints the diffs and the exact command line a promote needs.

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
Chapter 11 is that pass.

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

### A migration cannot quietly lose data

The model planner has always refused a destructive *diff* when it generates a migration.
Nothing used to judge what **authored** SQL does to rows that already exist. A hand-written
`DROP TABLE`, a `DELETE`, or a create-copy-rename rebuild that forgot a column ran unchecked
against a populated scope.

Now one check runs inside every authored migration's transaction, on both adapters. **It
measures; it does not parse.** A migration made only of `CREATE` and `ALTER TABLE … ADD` costs
nothing. Anything else counts every module table before the first statement and after the
last: rows, and each column's values per storage class. Counting every table rather than the
named ones is what makes a trigger or a cascade visible. For a table that held rows, it refuses
the table gone or shrunk, a column that held values gone or emptier, or values changing
storage class, which is a narrowing retype such as `'1.50'` becoming `1`.

A loss you intend is declared on the migration, beside the SQL:

```ts
{
  version: '0003-drop-legacy-notes',
  statements: ['DROP TABLE notes'],
  discards: { notes: 'superseded by entries; exported before this release' },
}
```

`discards` needs a reason. `moves: { source: target }` is the other declaration, and it is
**verified by counts**: the target must gain, per storage class, as many values as its sources
held, so a move that drops values is refused. It does not compare the values themselves, so a
move that keeps the counts and changes the values passes.
"Data" means rows that exist in that table in that scope. An empty table may be dropped freely,
which keeps a development scope cheap to reshape.

If a promoted migration is refused in a scope, it rolls back inside its own transaction and
that scope fails closed, as any failed migration does. Promote moves a pointer and each scope
migrates on wake, so this happens a scope at a time. Each migration commits on its own, so the
migrations before the refused one in the same promote stay applied; the refused one never ran,
and the data it would have lost is intact. Promoting the previous version back works only if
that version can read the schema those earlier migrations left. Two things a count cannot see
are stated rather than hidden: values rewritten in place at the same count and storage class,
and rows replaced by as many other rows.

### Migrations keep their identity and their derived protections

An applied migration is held to the digest of the SQL that actually ran. Editing that
SQL under the same migration identity fails closed; write a new migration instead.
An authored table rebuild must also preserve the columns the journal says exist.
The migration pass re-establishes derived archive/trash guards, list indexes and search
triggers, or refuses the migration inside its transaction. A create-copy-rename cannot
quietly remove the kernel's enforcement.

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

A preview or fork is barred from outward side effects and recurring schedules. Preview
URLs are non-public: gated code running against real-shaped data.

**A copy of any size, even a busy one.** A copy used to move a scope as one value, one
Durable Object message of at most 32 MiB, so a production-sized scope simply could not be
forked. Now the export answers a few MiB at a time and the destination stages the pages and
commits them through the same load path a whole dump takes. A scope that keeps taking writes
while it is copied used to be refused after three tries. Now the first page opens a capture on
the source, a log of changed rows kept by triggers, and the copy catches up from it until a
batch comes back final. That moment is the one the copy is true at. A capture is invisible
from outside and expires by itself if the copy stops. A copy over the size limit is refused
before its first page.

**A preview you can sign in to.** A clean-room preview, with no production data, used to
have no login at all. Now a vertical can name a sample world, `src/world.ts`, and seat it,
personas included, inside a clean-room preview. The platform runs a small OpenID provider per
preview, so a token minted for one preview names an issuer no other preview trusts. Its picker
answers only someone signed in to Substrat who is on the preview's team, and logs each persona
sign-in with the person who made it. A persona's principal is derived from the scope and its
subject, so it survives a push that brings an empty identity directory.

**A fork of production is judged as the person asking.** The platform checks that person in
the app's own scope before copying anything. They must be the owner of record, or hold every
role the owner holds there. A team role confers nothing, because "admin" is not a platform
concept when every app names its own roles. A credential that names nobody, such as a CI push
token, keeps its old rule, since it can already push code onto the production scope itself.

There is a broader rule underneath this: **a copy keeps history without re-running the
source's work**. Loading a dump into a different scope id drops the source's capability
links, settles copied pending intents and jobs as failed with a reason, and terminates
copied executor retries. A copied-events mark stops historical events being consumed or
shipped to the lake again. Loading a backup back into its original scope is a return,
which preserves its work. Unknown provenance is treated as a copy.

Keep that separate from preview isolation. An ordinary copy can create new work of its
own; it is the preview/fork classification that bars outward effects. A source share
link never becomes authority to open its copy.

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

Backups, restores, snapshots and copies now all move a page at a time, so they keep working
when a scope outgrows one call. A restore also puts back each module table's own indexes and
guard triggers, which it had been dropping. The directory's own backup was the case that
mattered most. Its dump had outgrown the control plane's memory, so for two months each
scheduled backup restarted the directory's object, failed whatever was in flight, and stored
no copy, and the next pass tried again. It is paged now.

## The whole shape

Push submits source and the platform builds a version from it. Admission asks whether it may
run here, mechanically when you are the only tenant exposed and with a human when you list it. Promotion points the one channel
and serves **in place**, so data carries forward and migrations run forward against it, each
scope on wake. Previews rehearse a risky version against a fork. PITR rewind and
backup/restore are the backout.

The staff gate lives at **publish** — the moment other tenants can run your code against
their data — and nowhere else in the loop.

---

**Next:** [The two clocks →](/book/11-the-two-clocks)
