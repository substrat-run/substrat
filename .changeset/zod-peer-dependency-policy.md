---
'@substrat-run/contracts': minor
'@substrat-run/contract-tests': minor
'@substrat-run/model-emit': minor
'@substrat-run/engine-absence': minor
'@substrat-run/engine-booking': minor
'@substrat-run/engine-invites': minor
'@substrat-run/engine-invoicing': minor
'@substrat-run/engine-metering': minor
'@substrat-run/engine-protocol': minor
'@substrat-run/engine-workorder': minor
'@substrat-run/connector-scrive': minor
---

**zod is now a peer dependency.** Install it alongside these packages:

```sh
npm install zod@^4.4.0
```

Every package here hands out zod schemas that a consumer parses with, composes
into their own, and that `mountOperations` reads `_zod.def` off to find pinned
literals. Two copies of zod in one tree means an object made by one is not
recognised by the other, and the symptom — `expected a Zod schema` — points
nowhere near the cause. A peer dependency says *use the consumer's copy*.

The declared range is `^4.4.0` rather than the exact version this repo builds
against: a peer range should state what the code supports, and pinning it to
`^4.4.3` would refuse a consumer on 4.4.0 for no reason.

**A defect this found.** `@substrat-run/contract-tests` shipped **130
`import("zod")` references in its published `.d.ts` while declaring zod
nowhere.** It resolved only because contracts had zod as a regular dependency,
which hoisted a copy into view — not a dependency, a coincidence. It now declares
it. Two more of the same class turned up when the tree shifted: packages using
`setTimeout`/`atob`/`btoa` — globals absent from `lib: ES2023` — compiling on an
ambient `@types/node` nobody had declared.

That is the general rule now enforced by `pnpm lint:deps`
(`tools/declared-deps.mjs`) in CI: **every module a package references, in its
source or its emitted `.d.ts`, must be one it declared.** The `.d.ts` half is the
sharp one — TypeScript writes the original specifier into declarations however
the source imported it, so re-exporting `z` through contracts still emits
`import("zod")` into a dependent's types.

**Why a lint rather than pnpm's own enforcement**, measured rather than assumed:
`autoInstallPeers` (pnpm's default) turns a peer conflict into a silent second
copy — with contracts peer-requiring `^4.4.3` and a consumer declaring `^3.23.0`,
pnpm reported nothing, and `zod` did not appear once in the peer report even
under `--strict-peer-dependencies`. And pnpm's peer checking does not reach
`workspace:` links at all. Full reasoning in `docs/design/dependency-policy.md`.

Internally, shared versions now come from a pnpm `catalog:` so one version is a
single edit. The `pnpm` settings block moved from `package.json` to
`pnpm-workspace.yaml`, which is where pnpm 10 reads it — it had been ignored,
with `overrides` surviving only because they were baked into the lockfile.

Closes #742.
