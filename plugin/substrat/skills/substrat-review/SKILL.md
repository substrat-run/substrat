---
name: substrat-review
description: Review the current Substrat vertical change against Substrat's own rules (scope isolation, permission checks, generated files, migration losses, personal data, lifecycles, secrets, tests). Run it before pushing a vertical change or opening a PR, after the editor's built-in review. Use when asked to review, check or audit a change to a Substrat vertical.
---

# Review a change against the Substrat checklist

The editor's own review finds compile errors, logic bugs and generic security issues. This
finds the failures that look like success on a Substrat vertical: a query around the
kernel, an operation with no permission check, a hand-edit to a generated file, a migration
that drops data. Run it **after** the built-in review, before you push.

The rules are in [`plugin/substrat/review/checklist.md`](../../review/checklist.md) in the
plugin. Read that file in full first. It is the only copy: this skill adds a procedure, not
rules, and the PR job runs this same procedure against the same file.

## Procedure

1. **Find the diff.** Against the branch the change will merge into, not against `HEAD`:
   `git diff $(git merge-base origin/main HEAD)...HEAD`, plus uncommitted work
   (`git status --short`). If the base is not `main`, say which you used. An empty diff is
   a result: say so and stop.
2. **Run the gates the checklist names**, in the vertical's own project, and read their
   output. A gate that cannot run here (not built, dependency missing) is reported as *not
   run*. Do not guess its answer.
3. **Read the diff against each item.** Open the changed files, not only the hunks. Whether
   an operation checks a permission is not visible in the line that was added.
4. **Report in the checklist's shape**, every finding with `file:line`, and the clean items
   and gates run listed at the end.

## What you do not do

- **Do not edit anything**, and do not regenerate an artifact to make a gate pass: a red
  `--check` is the finding.
- **Do not pass a checkpoint.** If the change touches migrations or permissions, present
  the diff the way the checklist says and leave `--ack-migrations` / `--ack-permissions` to a
  person. Never pass them yourself or tell a subagent to.
- **Do not widen the scope.** Code the diff did not touch is not this review's business.
- **Do not soften a blocking item.** If you are unsure whether something is a violation,
  report it as one, say what you could not confirm, and let the author answer.
