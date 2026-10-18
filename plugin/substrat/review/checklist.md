# Substrat review checklist

One rule set, any runner: the `review` skill (run it locally before you push) reads it
today, and a runner the platform hosts is meant to read the same file. Edit the rules **here
and nowhere else**. No runner carries its own copy.

This checklist exists because the failures it names *look like success*: they compile, the
tests pass and the page renders. Review that is already built into your editor catches
compile errors, logic bugs and generic security problems; read this list for what only
Substrat's rules can see.

## How to apply it

- Review **the change**, not the whole tree. A finding must point at a line the change adds
  or alters (`file:line`), quote it, and say how it fails. Pre-existing problems are out of
  scope unless the change makes them reachable.
- **Run gates read-only.** Only the `--check` form of a gate, and only a gate that has one:
  a bare `lint:model`, `lint:permissions` or `lint:agent-rules` rewrites files, which a
  review must not do. A gate with no read-only form is not run.
- **Gate invocation.** In the monorepo, pass `--check` through `pnpm run`
  (`pnpm run lint:migrations --check`). `pnpm lint:migration-fence` has no `--check` form but
  only replays and reports, so it is safe to run.
- **Which gates exist depends on where you are.** In a project made by `npm create substrat`
  there are three: `npm run lint:boundaries`, `npm run typecheck`, `npm test`. The rest named
  below (`tools/…`, `pnpm lint:…`) exist in the Substrat monorepo, where the demos live. If a
  gate is not there, say *not available here* and review that item by reading; do not report
  a missing script as a failure.
- **A gate that already refuses it is not your job to repeat.** Each item names the
  mechanical check, where there is one. Run it, and report its failure instead of
  re-deriving it. Spend your reading on the part no gate can see, which the item's *Look
  for* lines say.
- **Each item ends with a `gates:` line**, the machine-read list of the commands that refuse
  it: monorepo commands (`pnpm …`, `node tools/…`) and the scaffold's (`npm …`). `judgement`
  in that list marks what no script can decide, which is the part to read; an item that is
  `gates: judgement` alone has no mechanical half. `pnpm lint:review-checklist` holds every
  command named there to one that exists and that CI runs, so a gate listed here is a gate
  that bites. `<ref>` stands for the base branch (`origin/main`).
- Severity is per item. **blocking**: the change is unsafe to merge as written.
  **advisory**: worth a comment, never a stop.
- No finding is a valid result. Say which items you checked and found clean. Do not invent
  a finding to fill a report.
- Never edit files, regenerate artifacts or acknowledge a checkpoint while reviewing. The
  two human checkpoints (migration diff, permission diff) are a person's to approve; your
  job is to make the diff legible, not to pass it.

## Items

Each item is a rule, the gate that already enforces part of it, and what only a reader can
see. Where a gate exists it is the first thing to run.

### S1 · Scope isolation: blocking

Tenant data is reached through `ctx.sql`, inside an operation, and nowhere else.

- *Gate:* `npm run lint:boundaries` in a scaffolded project; `node tools/boundary-lint.mjs`
  in the monorepo. Red: report it and stop on this item.
- *Reader:* spellings a linter cannot see: another module's table named in SQL, a binding or
  stub that reaches a different scope, `fetch` in module code.

gates: `node tools/boundary-lint.mjs` · `npm run lint:boundaries` · judgement

### S2 · Every operation checks a permission: blocking

The first line of a handler is `assertAllowed(await ctx.check(PERM))`, and `PERM` exists in
the permissions source.

- *Gate:* `pnpm lint:permissions --check` goes red when the surface changed and
  `PERMISSIONS.md` was not re-emitted. Name every widened role in the report. This is the
  **permission-diff checkpoint**: present it, and stop there. An operation declaring a check
  on one entity (`{ key, entity, idFrom }`) is held to it by `entityCheckConformanceSuite`,
  which the package's tests run (`pnpm lint:entity-check-adoption` refuses a package with such
  operations that never calls it).
- *Reader:* an operation with no check; a check on a key that grants less than the operation
  does; a scope-wide key where the operation addresses one entity. No gate sees a handler
  that checks a weaker key than the model declares, because the declaration did not change:
  for every operation the change touches, open `spec/model.ts` and compare the key it
  declares with the key the handler checks.

gates: `pnpm lint:permissions --check` · `pnpm lint:entity-check-adoption` · `pnpm test` · judgement

### S3 · Generated files and kernel packages are not edited by hand: blocking

- *Gate:* each generated artifact has a `--check` re-emit (`lint:model`, `lint:api`,
  `lint:client`, `lint:permissions`, `lint:migrations`). Report the red one and name the
  source file to edit instead.
- *Reader:* a diff to a `*.generated.*` file, `model.json`, `openapi.json`, an emitted
  migration or `@substrat-run/*` code, with no change to the source it comes from.

gates: `pnpm lint:model --check` · `pnpm lint:api --check` · `pnpm lint:client --check` · `pnpm lint:permissions --check` · `pnpm lint:migrations --check` · `pnpm lint:generated-marks` · judgement

### S4 · Migrations are append-only and declare what they lose: blocking

- *Gate:* `pnpm lint:migration-fence` replays every authored migration against populated
  data and refuses an undeclared loss. `pnpm lint:migration-ledger --base origin/main`
  refuses a migration the base branch shipped that is now edited, removed or renumbered
  (each package's `MIGRATIONS.md` records the digest a scope checks).
- *Reader:* a declared `discards` whose reason does not match
  what the SQL does (a declaration is not a pass). This is the **migration-diff
  checkpoint**: present the diff plainly, and stop there.

gates: `pnpm lint:migration-fence` · `pnpm lint:migration-ledger --base <ref>` · `pnpm lint:migration-ledger --check` · `pnpm lint:migrations --check` · judgement

### S5 · Personal data is classified and erasable: blocking

- *Gate:* the compiler refuses an `erasable` field in an event payload. `pnpm lint:model`
  (monorepo) only *warns* on `erasable` with no `erasure`, so a clean run does not settle it.
- *Reader:* what counts as personal data is yours to judge. A new field holding a person's
  name, email, phone, address or free text they wrote must be in `erasable`; list each field
  you judged and why.

gates: `pnpm typecheck` · `npm run typecheck` · `pnpm lint:model --check` · judgement

### S6 · State changes go through declared lifecycles: blocking

- *Gate:* the compiler checks the joins between a lifecycle and its operations.
  `pnpm lint:lifecycle-writes` refuses a write of a declared lifecycle's state with no
  `assertTransition` / `transitionFor` (or a local wrapper of one) before it.
- *Reader:* a state field that should have a declared lifecycle and has none (the gate reads
  only declared ones); a transition coded but not declared; a guard asked in another file, or
  rewritten inline beside the lifecycle call.

gates: `pnpm typecheck` · `npm run typecheck` · `pnpm lint:lifecycle-writes` · judgement

### S7 · Secrets stay out of source and logs: blocking

- *Gate:* `pnpm lint:secret-literals` refuses a credential whose issuer gives it a shape (a
  PEM or JWK private key, a provider token prefix, a connection URL with a password). A
  secret with no shape gets past it.
- *Reader:* a literal secret with no recognisable shape (an HMAC key, a password, an API
  token without a prefix); a secret reaching a log line, an
  error, an event payload or a response; a secret name in public text (a PR description, a
  comment).

gates: `pnpm lint:secret-literals` · judgement

### S8 · A new operation has an acceptance test: advisory

- *Gate:* `pnpm lint:tests` refuses a test that reads the emitted model to decide what to
  assert. `pnpm lint:operation-tests --base origin/main` warns (never fails) on an operation
  new since the base that no test in its package names.
- *Reader:* an operation added with no scenario calling it, or only a happy path where it
  has a permission failure and a not-found.

gates: `pnpm lint:tests` · `pnpm lint:operation-tests --base <ref>` · judgement

## Not listed here

Event, clock and id rules (fat events, `ctx.now()`, `ulid()`, money as strings) and catching
an engine error without `ctx.atomic` are enforced by boundary-lint (R6, R7) and the contract
helpers.

## Report shape

Open with one line: `Substrat review: <n> blocking, <m> advisory`. Then one entry per
finding, most severe first:

```
[S2 blocking] demos/example/src/module.ts:84
  quote: async 'invoice/void'(ctx, input) { const inv = await getInvoice(ctx, input.id);
  fails when: no ctx.check; any member can void an invoice
  fix: first line of the handler: assertAllowed(await ctx.check(PERMS.invoiceVoid))
```

A problem you noticed that fits no item (a logic bug, say) is not filed under the nearest
item. List it under `Outside this checklist:` in one line each, and leave it to the general
review. A blocking item you could not settle is listed as `[S5 unconfirmed]` with what you could not
see. Say once, under the headline, that this checks Substrat's rules only and is not a general
code review. Close with three lists. `Checked clean:` is items you read the change against and found
nothing. `Not applicable:` is items the change gave nothing to apply to (no operation, no
migration). `Gates run:` is the commands and their exit status; a gate you did not run is
*not run* or *not available here*, never passed. Present a checkpoint diff (S2, S4) in the
report body, under its own heading.
