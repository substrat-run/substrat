---
status: built
layer: plan
description: Peer vs direct dependencies, and the declared-deps gate.
---

# Dependency policy

Status: adopted. Written after #742 asked a narrow question — should `zod` be a
peer dependency of `@substrat-run/contracts`? — and the investigation found that
the issue's premise did not hold. Everything below is measured on this repo
rather than inherited from general advice; where a claim is empirical the
measurement is given, because the ones that sounded most obvious are the ones
that turned out false.

## The rule

> **A package declares what its own public surface references. Anything whose
> *identity* must be shared with the consumer is a `peerDependency`, not a
> `dependency`.**

Two halves, and both earn their place below.

## 1. Identity-sharing → peer

zod objects cross `@substrat-run/contracts`' API boundary. A consumer takes a
schema this repo built, calls `.parse()` with it, composes it into its own
schemas, and `mountOperations` reads `_zod.def` off it to find pinned literals.
Two copies of zod in one tree means an object made by one is not recognised by
the other, and the symptom — `expected a Zod schema` — points nowhere near the
cause.

That is what `peerDependencies` is for: *use the consumer's copy, do not bring
your own*. React, tRPC and drizzle all do this for the same reason.

**The range is deliberately wider than the pin.** Published packages declare
`zod: ^4.4.0`, not `^4.4.3`. A peer range states what the code supports; pinning
it to the exact version the workspace happens to build against refuses a consumer
on 4.4.0 for no reason at all. The pin belongs in the catalog (§3).

## 2. "Declare what you reference" — and the shortcut that does not work

The tempting alternative is a chokepoint: **only contracts depends on zod;
everyone else imports `z` from contracts.** One copy by construction, one
declaration to maintain, enforceable with a lint. It is a genuinely attractive
design and it does not work.

TypeScript's declaration emit writes the **original module specifier** into
`.d.ts` regardless of how the source imported it. Re-exporting `z` through
contracts still emits `import("zod").ZodObject<…>` into the dependent's types.
Measured on this repo: **130 such references in `packages/contract-tests`, 13 in
`engines/invites`.** A package whose published types say `import("zod")` requires
zod to be resolvable by its consumer, whatever its source code imported.

So the dependency is real, and it must be declared.

### The defect this found

`packages/contract-tests` published **130 `import("zod")` references while
declaring zod nowhere.** It resolved because contracts had zod as a regular
dependency, which hoisted a copy into view. That is not a dependency — it is a
coincidence, and it breaks the moment the tree shifts. Two more of the same class
surfaced when the tree did shift: `contract-tests` and `packages/kernel` both
used `setTimeout`/`atob`/`btoa`, globals absent from `lib: ES2023`, compiling only
on an ambient `@types/node` that somebody else's dependency happened to hoist.
Both now say `"types": ["node"]` and declare it.

## 3. One version internally: the catalog

`pnpm-workspace.yaml` carries a `catalog:`, and workspace packages reference
`catalog:` instead of a literal range. Bumping a shared version is one edit, and
a package that wants a *different* version has to write a literal — which is
visible in review rather than indistinguishable from drift.
`packages/builder-generator` is the one such case: `zod: ^3.23.0`, because the AI
SDK is on zod 3.

Drift between workspace packages was the actual source of most peer noise here:
two packages had moved to vitest 4 while everyone else was on 3, and one demo to
`@cloudflare/workers-types` 5 while everyone else was on 4. Neither was an
upstream problem. Both were the workspace disagreeing with itself.

## 4. What pnpm will and will not enforce — measured

This is the part that contradicts #742, and it is why the policy leans on a lint
rather than on settings.

**`autoInstallPeers: true` (pnpm's default) turns a peer conflict into a silent
second copy.** With contracts peer-requiring `zod ^4.4.3` and `packages/model-emit`
declaring `zod ^3.23.0`, `pnpm install` resolved model-emit to zod 3.25.76 and
**reported nothing at all**. `zod` did not appear once in the peer report — not
even under `--strict-peer-dependencies`.

**pnpm's peer checking does not reach workspace-linked packages.** Setting
`autoInstallPeers: false` *and* `strictPeerDependencies: true`, then having
`demos/todo` declare `zod ^3.23.0` against contracts' `^4.4.0` peer, produced
three missing third-party peers (tailwindcss, monaco-editor, search-insights) and
still no mention of zod. Peer checking works; it just does not apply to
`workspace:` links.

**Therefore neither setting is enabled.** They would add real churn — every
third-party transitive peer needing a declaration or an ignore rule — and catch
none of what this policy exists to catch. The peer declarations still matter, and
matter most, for consumers installing these packages *from npm*, where pnpm's
checking does apply and where a second zod is a real risk.

A further caveat worth knowing: `strictPeerDependencies` fails at **resolution**
time. A CI run using `--frozen-lockfile` skips resolution, so it would not fire
there anyway.

## 5. The gate: `tools/declared-deps.mjs`

`pnpm lint:deps`, in CI after the build. For every workspace package, every bare
module specifier appearing in its **emitted `.d.ts`** or its **source** must be
declared in its `package.json`. It runs after the build because the sharp half
reads declarations, which only exist once built.

This is the check that actually holds, because it is ours: it does not depend on
pnpm settings, it cannot be short-circuited by an up-to-date lockfile, and it
generalises past zod to any module. It would have caught `contract-tests` years
earlier.

Its limits are stated in its header rather than left to be discovered: it reads
text, not an AST, so an import-shaped string inside a template literal is
indistinguishable from a real import. The failure mode is a loud false positive,
never a silent pass — the right way round for a check whose job is to refuse.

## 6. Settings live in `pnpm-workspace.yaml`

They used to live in `package.json`'s `pnpm` field, which **pnpm 10 stopped
reading**. Every command printed a warning saying so. `overrides` survived only
because they were already baked into the lockfile — the configuration was running
on inherited state rather than on anything anyone had written down. Moving the
block was a prerequisite for any of the above, since a setting nobody reads
enforces nothing.

## Known follow-up

`vitest` is pinned at 3.x because vitest 4 requires
`@cloudflare/vitest-pool-workers` 0.21, which replaced `defineWorkersConfig` with
a vitest-4 plugin API and ships a codemod for the migration. That is a real
migration through the production Durable Object adapter and does not belong in a
dependency-policy change. One peer conflict survives until it lands: wrangler
4.123 wants `workers-types ^5`, pool-workers 0.9 wants `^4`. The catalog is what
makes that a one-line bump when the migration happens.
