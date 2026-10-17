# Substrat review checklist

One rule set, two runners: the `substrat-review` skill (run it locally before you push) and
the PR job in `.github/workflows/substrat-review.yml`. Edit the rules **here and nowhere
else**. Neither runner carries its own copy.

This checklist exists because the failures it names *look like success*: they compile, the
tests pass and the page renders. Review that is already built into your editor catches
compile errors, logic bugs and generic security problems; read this list for what only
Substrat's rules can see.

## How to apply it

- Review **the diff**, not the whole tree. A finding must point at a line the diff adds or
  changes (`file:line`). Pre-existing problems are out of scope unless the diff makes them
  reachable.
- **A gate that already refuses it is not your job to repeat.** Each item names the
  mechanical check, where there is one. Run it, and report its failure instead of
  re-deriving it. Spend your reading on the part no gate can see, which the item's *Look
  for* lines say.
- Severity is per item. **blocking**: the change is unsafe to merge as written.
  **advisory**: worth a comment, never a stop.
- No finding is a valid result. Say which items you checked and found clean. Do not invent
  a finding to fill a report.
- Never edit files, regenerate artifacts or acknowledge a checkpoint while reviewing. The
  two human checkpoints (migration diff, permission diff) are a person's to approve; your
  job is to make the diff legible, not to pass it.

## Items

### S1 · Scope isolation: blocking

Every read and write of tenant data goes through `ctx.sql`, inside an operation.

- *Look for:* a data-access import (`better-sqlite3`, an adapter, `node:*`,
  `cloudflare:workers`) in code reachable from an operation or consumer; a query that names
  another module's table; anything that reaches a different scope's data (a binding, a
  stub, an ambient `env`); `fetch` in module code.
- *Gate:* `node tools/boundary-lint.mjs` (`pnpm lint:boundaries` in a scaffolded project).
  If it is red, report that and stop on this item. If it is green, still read the diff for
  the spellings a linter cannot see.

### S2 · Every operation checks a permission: blocking

The first line of an operation's handler is `assertAllowed(await ctx.check(PERM))`, and
`PERM` exists in the permissions source.

- *Look for:* a new or changed operation with no check; a check on the wrong key (one that
  grants less than the operation does); an entity-addressed operation checking the
  scope-wide key where a per-entity check is needed; a role widened to hold a key it did not.
- *Gate:* `pnpm lint:permissions --check` fails when the permission surface changed and
  `PERMISSIONS.md` was not re-emitted. A widened role is then visible in the PR diff, which
  is the point. Name every widened role in your report.

### S3 · Generated files and kernel packages are not edited by hand: blocking

- *Look for:* a diff to a `*.generated.*` file, to `model.json`, `openapi.json`,
  `PERMISSIONS.md`, an emitted migration, or anything under `node_modules`/`@substrat-run/*`,
  where the same PR does not also change the source it is generated from.
- *Gate:* each generated artifact has a `--check` re-emit (`lint:model`, `lint:api`,
  `lint:client`, `lint:permissions`, `lint:migrations`). Report the one that fails and name
  the source file to edit instead.

### S4 · Migrations are append-only and declare what they lose: blocking

- *Look for:* an edit to a migration that already shipped (a version is never rewritten); a
  new migration that drops a table or column, narrows a type, or rewrites values without
  declaring it with `moves` (verified) or `discards` (with a reason); a declaration whose
  reason does not match what the SQL does.
- *Gate:* `pnpm lint:migration-fence` replays every authored migration against populated
  data and refuses an undeclared loss. A declared `discards` is not a pass: read its reason
  against the SQL and say whether it is true.
- This is also the **migration-diff checkpoint**. Present the migration diff plainly, and
  stop there.

### S5 · Personal data is classified and erasable: blocking

- *Look for:* a new field holding a person's data (name, email, phone, address, free text a
  person wrote) that is not in the entity's `erasable` list; an entity with `erasable`
  fields and no `erasure`; a field that is erasable *and* copied into an event payload (a
  payload cannot carry one); an event about a person with `piiClass: 'none'`.
- *Gate:* `pnpm lint:model --check` and the compiler refuse the structural cases. The
  judgement of *what is personal data* is yours: list each field you judged and why.

### S6 · State changes go through declared lifecycles: blocking

- *Look for:* a hand-written `UPDATE … SET status = …` or an operation that writes a state
  column directly; a transition added in code and not in the lifecycle declaration; a guard
  re-implemented inline beside a lifecycle that already draws that edge.
- *Gate:* the compiler checks the joins between a lifecycle and its operations. It cannot
  see a raw write to the column. Look for it.

### S7 · Every mutation emits a fat event, and time and ids come from the context: blocking

- *Look for:* a write path with no event; an event payload a consumer would have to make a
  cross-module read to use; `new Date()` / `Date.now()` instead of `ctx.now()`; a hand-rolled
  id instead of `ulid()`; money or decimals as floats instead of the contracts helpers.
- *Gate:* boundary-lint R6 refuses the clock spellings. The rest is reading.

### S8 · Secrets are not in the source or the logs: blocking

- *Look for:* a literal token, key, password or connection string; a secret echoed into a
  log line, an error message, an event payload or a response body; a `.env`-style file in
  the diff; a secret name written into public text (a PR description, a comment).
- *Gate:* none that is complete. Read every added string that looks like a credential, and
  every `ctx.log` / `console.*` argument that touches a request header or a connection.

### S9 · A new operation has an acceptance test: advisory

- *Look for:* an operation added to the model with no scenario that calls it; a scenario
  that only drives the happy path where the operation has a permission failure and a
  not-found; a test that reads the emitted model to decide what to assert (it then agrees
  with the generator rather than with the vertical).
- *Gate:* `pnpm lint:tests` refuses the last case.

## Report shape

Open with one line: `Substrat review: <n> blocking, <m> advisory`. Then one entry per
finding, most severe first:

```
[S2 blocking] demos/example/src/module.ts:84
  operation invoice/void has no permission check; the role `member` can now void invoices
  fix: first line of the handler: assertAllowed(await ctx.check(PERMS.invoiceVoid))
```

Close with `Checked clean:` followed by the item ids with no finding, and
`Gates run:` followed by the commands you ran and their exit status. A gate you did not run
is listed as *not run*, never as passed.
