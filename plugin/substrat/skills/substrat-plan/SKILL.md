---
name: substrat-plan
description: Show the concept delta of a change to a Substrat vertical at the design gate — entities before and after, lifecycle and permission changes, the spec-version impact and the decisions-log entry — and stop for the user's approval before any code. Use when asked to plan a change, show what a change does to the model, or run /plan on a Substrat vertical that already has a model.json.
---

# Plan a change: the concept delta at the design gate

The design gate is a hard stop before any code. What the user approves there must be
something they can read: a change that splits an entity, adds a lifecycle state or breaks
an API consumer is invisible in prose. `substrat plan` renders it from the artifacts of
record instead. This skill runs it, shows it, and stops.

## Procedure

1. **Find the vertical.** The directory with the `package.json` beside a `model.json`. A
   project with no `model.json` yet is a first design, not a change: follow the project's
   own playbook (`.substrat/playbook.md`, Step 4) instead.
2. **Declare the change, and only the change.** Edit `spec/model.ts` (entities, operations,
   lifecycles) and the roles, then re-emit the artifacts the way the project does
   (`pnpm lint:model`, `pnpm lint:permissions`, `pnpm lint:api` in the Substrat repository).
   Write no handler, no screen and no migration yet: the gate is upstream of code. A stale
   `model.json` gives a delta of the old model, so re-emit before every run.
3. **Run the delta**, from the vertical's directory:

   ```bash
   substrat plan --why "<the user's reason, in their words>"
   ```

   `--base <ref>` when the change is not against the default base (the changesets base
   branch, else `main`). For your own reading, `--json` gives the same delta as data.
4. **Show it as printed**: entities with the model before and after, lifecycle changes with
   the operation that triggers each transition, the permission-diff table, the spec-version
   impact and its reasons, and the proposed decisions-log entry. Do not summarise it away.
   Then walk the user through it in **their** vocabulary until they can answer, without your
   help: *who can see the money, and who can see other customers' data?* If the impact is
   `major`, say plainly who it breaks (a caller of a removed operation, a reader of a removed
   field) before asking.
5. **Stop.** Ask for approval or for changes, and wait. If they ask for changes, edit the
   declaration, re-emit and go back to step 3: the delta, and its digest, change with it.
6. **Only after the user says yes**, run the approve line the delta printed, with their name
   and their reason:

   ```bash
   substrat plan --approve <digest> --by "<their name>" --why "<their reason>"
   ```

   That appends the entry to the Decisions log of `spec/concept.md` and re-syncs its
   generated sections. A refusal saying the delta changed means the model moved after they
   read it: show it again (step 3) rather than retrying with the new digest. Then the build
   may start.

## What you do not do

- **Never run `--approve` on your own judgement**, on a guess at what the user would say, or
  for a subagent. The approval is the user's; the command only records it. The same holds
  for the two later checkpoints (migration diff, permission diff), which this does not
  replace.
- **Do not edit the generated sections of `spec/concept.md`** or write the decisions-log
  entry by hand to get past the gate. `--approve` writes it from the delta that was shown.
- **Do not start the implementation** — handlers, migrations, screens — before approval.
