# Environments & previews

A vertical you own has exactly **one channel — `prod`** ([the deploy model](/concepts/deploying#the-one-channel-prod)).
There is no `dev`, no `staging`. That is not a missing feature; it is the point. On most
platforms an *environment* is a second deployment — another machine running other code. Substrat
inverted both halves: code is shared and nearly free (one hibernating Durable Object class per
version), and the isolation boundary is the **scope**. So the thing that separates one
environment from another here is *which scope*, not *which deployment* — and a scope with its
own data already has a name and a URL. A second pointer at the same code would add nothing.

So a non-production environment on Substrat is a **[preview](#previews-the-non-prod-primitive)**:
a scope with data, bound to a version, reachable at its own hostname. This page is how you use
that one primitive to get every workflow the old three-environment ladder gave you — and a few
it couldn't.

## The mental model: an instance is `(scope × version)`

Three primitives, and the whole page falls out of how they compose ([preview & snapshots
RFC](https://github.com/substrat-run/substrat/blob/main/docs/architecture/preview-and-snapshots.md) §2):

| Primitive | Mutability | Git analogy |
|---|---|---|
| **version id** → a `deploymentRef` | **immutable** — a pushed build never changes | a commit **sha** |
| **binding** (`bindScopeVersion`) — which version a scope runs | **mutable** by design | a **branch ref** |
| **hostname** → resolves to a **scope** | stable; names a scope, never a version | a checkout path |

A running app is a **scope bound to a version**, fronted by a hostname. The router resolves
`hostname → scope`, then dispatches on *whatever version that scope is currently bound to*. Nothing
more names an environment.

This is why **prod is already a moving target**: the prod hostname points at the prod scope, and a
[promote](/guide/deploying#promote-to-prod) rebinds that scope to a new version. "test" and "prod"
are the *same shape* — a stable scope + a stable hostname whose binding moves. The only thing that
differs is **what triggers the rebind, and how gated it is**:

- **prod** — the binding moves on an explicit, acknowledged [promote](/guide/deploying#promote-to-prod);
  across a shared vertical's tenants it cascades.
- **test** — the binding moves automatically on every merge to `main`, on one scope, ungated,
  driven from CI.

## Previews: the non-prod primitive

A preview is a scope with data bound to a version, at its own `--<tag>` hostname. You create and
manage them with [`substrat preview`](/reference/cli#preview):

```bash
substrat preview create . --tag pr-42          # push this tree, fork prod, serve the pair
# ✓ preview 'pr-42' → https://helpdesk-acme--pr-42.global.substrat.run
substrat preview ls
substrat preview delete --tag pr-42            # reap it (idempotent)
```

`create` pushes the working tree (so the bound version is exactly this code), forks the vertical's
prod scope, binds the pushed version to the fork, and mints a non-canonical `--<tag>` hostname. Two
properties do the heavy lifting:

- **A preview is idempotent per tag.** Re-running the same `--tag` — what a new push to a PR does —
  **rebinds the new version onto the same fork**. Successive pushes roll their migrations *forward*
  on one copy, which is the rehearsal that actually de-risks a release: the fork accumulates schema
  changes exactly the way prod will. `--refresh` starts over from a clean fork of prod.
- **A prerelease label never steals a release coordinate.** A default preview push is labelled
  `<pkg>-<tag>.<n>` (a semver *prerelease*), and the registry's `nextVersion` only counts anchored
  `x.y.z` releases — so preview pushes are free: they never collide with, and never advance, the
  version your repo owns. (Pass `--version` to pin an exact label.)

Every preview carries a TTL (`--ttl 72h` by default) so an abandoned one is garbage-collected even
if never deleted — and reuse **renews** the deadline, so an actively-pushed preview never dies under
you. `--ttl none` **pins** it until you delete it (see [the test environment](#a-long-lived-test-environment) below).

::: tip Previews are for a vertical you own
A preview forks *your own tenant's* scope and serves no install, so a builder may preview a vertical
they own whether it is **private or listed** — publishing widens who may *install*, not who may
preview their own pending code (#513). What a preview will not do is fork a scope pinned tighter than
`global`-jurisdiction, or fork a first-party vertical you don't own.
:::

### A vertical's *first* environment — the clean room

A fork needs something to fork. A brand-new vertical has no prod scope yet — exactly when a
throwaway environment is most useful. `--empty` provisions a **clean-room** scope instead of forking:
module tables migrated, version bound, hostname minted, no data.

```bash
substrat preview create . --tag sandbox --empty     # a source-less environment
```

It follows the tenant-app hostname convention (`<vertical>-<tenant>--<tag>.<base>`) since there is no
source URL to derive from. This is the "empty / seed data → clean-room preview" cell of the model —
a first environment before any prod exists (#514).

## Sticky-per-PR **and** per-build URLs

Because a hostname names a *scope*, and the router serves *that scope's current binding*, two URLs on
one scope cannot resolve to two different versions. That single fact dictates the shape of good PR
previews — and it is exactly git's branch-vs-sha discipline:

| URL | Backed by | Behaviour |
|---|---|---|
| **Sticky PR URL** — `…--pr-42.<base>` | one long-lived fork, **rebound every push** | always the latest push on the PR; bookmark it once. The *branch ref*. |
| **Per-build URL** — `…--pr-42-<run>.<base>` | a **fresh** scope per build, **never rebound** | frozen to exactly that build, forever. The *sha*. |

The sticky URL is what a reviewer watches; the per-build URL is what you paste into a comment when a
regression appears in *one specific build* and must stay that build. The moving pointer is only safe
*because* every build is also addressable immutably — you can always de-reference "the bug on the PR
preview" down to a fixed artifact.

The recipe is two `preview create` calls per push:

```bash
substrat preview create . --tag pr-$PR                  # sticky: reused, renews its TTL
substrat preview create . --tag pr-$PR-$RUN --empty --ttl 24h   # per-build: fresh, short-lived
```

You do not have to write that yourself — [`substrat init --ci github`](/reference/cli#init) and the
dashboard's [one-click CI setup](/guide/deploying#deploy-from-ci) generate the same workflow, which
creates the sticky preview on every PR push and comments the URL back. The per-build call is **opt-in**,
because a frozen scope per build is a real cost: set the repository variable `SUBSTRAT_PER_BUILD_PREVIEW`
to `1` and the same workflow adds it, with the PR comment then naming **both** URLs — the one that
follows the PR and the one frozen to this build.

The per-build preview is deliberately `--empty` rather than a fork: it is thrown away within a day, so
copying prod data into it on every push would be pure cost. If you need a frozen copy *with* data,
that is a snapshot of the sticky preview, not a per-build one.

## A long-lived test environment

A "test environment that always runs the latest `main`" is just a **pinned preview whose binding is
rebound on every merge**, fronted by a custom domain. Nothing new — three primitives you already have:

1. **A durable scope.** Create it pinned so the GC sweep never reaps it:

   ```bash
   substrat preview create . --tag test --ttl none      # forks prod; or --empty for a fresh one
   ```

2. **A custom domain on it.** A hostname binds to *any* scope you own, not just prod — attach one
   with [`substrat scope domain`](/reference/cli#scope-domain):

   ```bash
   substrat scope domain <testScopeId> --domain crm-test.ahero.se
   # → verifying — publish the CNAME/TXT it prints; live when active
   ```

   The scope is now protected from reaping while that domain resolves, exactly like a prod scope
   ([the reap guard](/concepts/tenancy) counts any bound hostname).

3. **A rebind on every merge.** In the merge-to-`main` job, after the build, pin the test scope to the
   version you just pushed:

   ```bash
   substrat scope bind <testScopeId> --version <justPushedId> --snapshot
   ```

That is the whole thing. `crm-test.ahero.se` always serves the head of `main`; migrations roll forward
on its accumulated data, rehearsing every prod migration a merge earlier; and prod stays behind its
gated promote. All of it is manageable from the [dashboard](/platform/dashboard#previews-environments)
too — pin a preview, attach a domain, and (per app) bind a version — no CLI required.

::: info Why "tracks main" stays a CI step, not a platform setting
Substrat *enables* this workflow; it deliberately does not *encode* it. A "this scope auto-tracks tag
X" toggle would be a new environment noun — the same temptation the retired `dev`/`staging` channels
gave in to, re-buried one layer down. A one-line `scope bind` in your merge job is more legible and
composes with any branching model. Revisit only if you have many test slots wanting a shared rule.
:::

## Canary & pinned tenants — per-scope rollout

The same [`scope bind`](/reference/cli#scope-bind) primitive is the whole rollout axis for a **shared**
vertical with many tenant scopes. A prod promote cascades every tenant to the new version; when you
want *tenant A first*, bind that one scope ahead:

```bash
substrat scope bind <tenantA-scopeId> --version <next> --snapshot   # canary one tenant
# … watch it, then promote prod to bring the rest along
```

`--snapshot` forks the scope's data before a migration-crossing bind, so a bad version leaves the prior
one still runnable at its correct migration frontier — [fork-before-you-promote](/concepts/deploying#previews-run-a-version-against-a-copy-of-the-data),
applied per scope. A binding drift is native and expected: an install pins "prod-at-the-time", and
`Update to latest` is the per-scope catch-up. The channel was always the *weaker* abstraction here —
it can't express "tenant A first"; the binding can.

## The release workflow: pnpm + changesets

The version your repo owns lives in `package.json`, not in a registry counter — so a merge does **not**
move it, and only a release does. This is the workflow the generated CI encodes, and it maps cleanly
onto the primitives above:

| Moment | Version label | What runs | Where |
|---|---|---|---|
| **PR opened / pushed** | `<next>-pr-<n>.<k>` | `preview create --tag pr-<n>` | sticky `…--pr-<n>`, a fork of prod |
| **Merge to `main`** (changeset lands; version does **not** move) | `<pkg>-test.<run>` | `push`, then `scope bind <testScope>` | `crm-test.ahero.se`, the long-lived test env |
| **Version PR** ("chore(release): version packages") | `<next>-pr-<n>.<k>` | nothing special — it is a PR, so it gets a PR preview | that preview **is** the release candidate: the code that is about to become prod, on a fork of prod data, while rejecting it is still free |
| **Version PR merges** (version moves) | `<pkg>` exactly | `push --version <pkg> --promote prod` | prod |

Note what row 3 does *not* need: a release-candidate channel, an `rc` tag, or any new noun. A
version PR is a pull request, so the ordinary PR preview already runs the release candidate against
forked prod data. The one thing that differs between it and the prod push is the version *label* — the
code is the same tree.

Two disciplines make this safe, and both are already true — this workflow just names them:

- **A non-release push never claims a release coordinate**, because prerelease labels are skipped when
  the registry computes the next version. PR previews, the test env, and the release candidate all push
  freely without punching holes in your version sequence.
- **The release candidate is the one moment** the *exact* artifact that will become prod runs against a
  fork of prod's data *while the change is still a PR* — i.e. while rejecting it costs nothing. It is
  also where the `--ack-permissions` / `--ack-migrations` acknowledgements are *earned* rather than
  typed at the same instant as the deploy.

::: tip Don't hand-roll it
Generate it:

```bash
substrat init --ci github --release changesets
```

[`substrat init`](/reference/cli#init) and the dashboard's
[one-click CI setup](/guide/deploying#deploy-from-ci) render the **same** workflow from the same
generator — merge-to-main release, the test-env rebind, and the PR previews with their comment. The
label discipline and the two-`preview`-per-push recipe are not something you should have to re-derive
per vertical, and the reason this command exists is that the first workflow we shipped got the label
part wrong: it pushed `--version 0.1.<run number>` on every run, claiming a real registry coordinate
each time and punching holes in the version sequence.
:::

## See also

- [Deploying a vertical](/guide/deploying) — push, admission, promote prod, serve-in-place.
- [The deploy model](/concepts/deploying) — the concepts behind the one channel and in-place serving.
- [Snapshots & test copies](/concepts/snapshots) — the data-fork machinery a preview is built on.
- [`@substrat-run/cli`](/reference/cli) — `preview`, `scope bind`, `scope domain`, `promote`.
