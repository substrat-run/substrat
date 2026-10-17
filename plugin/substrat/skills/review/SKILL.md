---
name: review
description: Review the current Substrat vertical change against Substrat's own rules (scope isolation, permission checks, generated files, migration losses, personal data, lifecycles, secrets, tests). Run it before pushing a vertical change or opening a PR, after the editor's built-in review. Use when asked to review, check or audit a change to a Substrat vertical.
---

# Review a change against the Substrat checklist

The editor's own review finds compile errors, logic bugs and generic security issues. This
finds the failures that look like success on a Substrat vertical: a query around the
kernel, an operation with no permission check, a hand-edit to a generated file, a migration
that drops data. Run it **after** the built-in review, before you push.

The rules are in [`plugin/substrat/review/checklist.md`](../../review/checklist.md) in the
plugin. Read that file in full first. It is the only copy: this skill adds a procedure, not
rules, and any other runner should follow this same procedure against the same file.

## Procedure

1. **Find the change.** Everything that would land, committed or not:
   run `git fetch origin` first (a stale base drags in other people's merged commits), then
   `git diff $(git merge-base origin/main HEAD)`: commits, staged and unstaged work against
   the branch you will merge into (not against `HEAD`). If there is no `origin/main`, find the
   default branch (`git symbolic-ref refs/remotes/origin/HEAD`) and use that; if the merge-base
   command prints nothing, stop and say the base is unknown rather than reviewing a bare
   `git diff`. Add untracked files from
   `git ls-files --others --exclude-standard`; they are in no diff, so open them. If the base
   is not `main`, say which you used. If all of that is empty, say so and stop.
2. **Run the gates the checklist names that exist here**, in the vertical's own project, in
   their read-only `--check` form only, and read their output. Which gates exist depends on
   whether this is a scaffolded project or the monorepo; the checklist says which. A gate that cannot run here (not built, dependency missing) is reported as *not
   run*. Do not guess its answer.
3. **Read the change against each item.** Open the changed files, not only the hunks.
   Whether an operation checks a permission is not visible in the line that was added.
   Write down candidate findings; do not report them yet.
4. **Try to disprove each candidate.** For every one, reopen the code and look for the thing
   that would make it wrong: a check done by a caller or a derived handler, a gate that
   already covers it, a declaration elsewhere in the model. Keep it only if you can quote
   the offending line and state the concrete way it fails. Drop it otherwise, or, for a
   blocking item you could not settle either way, report it as *unconfirmed* and say what
   you could not see.
5. **Report in the checklist's shape**: surviving findings with `file:line`, the clean
   items, and the gates run.

## What you do not do

- **Do not edit anything**, and do not regenerate an artifact to make a gate pass: a red
  `--check` is the finding.
- **Do not pass a checkpoint.** If the change touches migrations or permissions, present
  the diff the way the checklist says and leave `--ack-migrations` / `--ack-permissions` to a
  person. Never pass them yourself or tell a subagent to.
- **Do not widen the scope.** Code the change did not touch is not this review's business.
- **Do not pad.** No finding is a valid result. A finding you could not tie to a quoted line
  is not one.
