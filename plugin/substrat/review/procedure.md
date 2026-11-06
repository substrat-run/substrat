# Substrat review procedure

How a runner applies [`checklist.md`](checklist.md) to a change. The checklist holds the
rules; this file holds the procedure. Every runner follows both: the local `review` skill
today, a runner the platform hosts later. Edit the procedure **here and nowhere else**.

## The rules digest

A report names the rules it was produced under. The **rules digest** is one SHA-256 over the
bytes of `checklist.md` followed by the bytes of this file, in that order, with nothing
between them. From the directory that holds both files:

```
cat checklist.md procedure.md | shasum -a 256
```

(`sha256sum` prints the same digest.) The report's headline carries its first 12 hex
characters. If you cannot compute it, write `rules ?`; never guess one. Two reports with
different digests were made under different rules.

## Procedure

1. **Find the change.** Everything that would land, committed or not:
   run `git fetch origin` first (a stale base drags in other people's merged commits), then
   `git diff $(git merge-base origin/<target> HEAD)`: commits, staged and unstaged work against
   the branch you will merge into (not against `HEAD`). `<target>` is that branch: a stacked
   change names its own base, and anything else targets `main`. If there is no `origin/main`,
   find the default branch (`git symbolic-ref refs/remotes/origin/HEAD`) and use that; if the
   merge-base command prints nothing, stop and say the base is unknown rather than reviewing a
   bare `git diff`. Add untracked files from
   `git ls-files --others --exclude-standard`; they are in no diff, so open them. A file with
   both staged and unstaged edits can land as either, so read its staged copy too
   (`git show :<path>`). If the base is not `main`, say which you used. If all of that is
   empty, say so and stop.
2. **Run the gates the checklist names that exist here**, in the vertical's own project, in
   the read-only form the checklist gives each, and read their output. Which gates exist depends on
   whether this is a scaffolded project or the monorepo; the checklist says which. A gate that
   cannot run here (not built, dependency missing) is reported as *not run*. Do not guess its
   answer.
3. **Read the change against each item.** Open the changed files, not only the hunks.
   Whether an operation checks a permission is not visible in the line that was added.
   Write down candidate findings; do not report them yet.
4. **Try to disprove each candidate.** For every one, reopen the code and look for the thing
   that would make it wrong: a check done by a caller or a derived handler, a gate that
   already covers it, a declaration elsewhere in the model. Keep it only if you can quote
   the offending line and state the concrete way it fails. Drop it otherwise, or, for a
   blocking item you could not settle either way, report it as *unconfirmed* and say what
   you could not see.
5. **Report in the checklist's shape**, headline and rules digest first: surviving findings
   with `file:line`, the clean items, and the gates run.

## What you do not do

- **Do not edit anything**, and do not regenerate an artifact to make a gate pass: a red
  `--check` is the finding.
- **Do not pass a checkpoint.** If the change touches migrations or permissions, present
  the diff the way the checklist says and leave `--ack-migrations` / `--ack-permissions` to a
  person. Never pass them yourself or tell a subagent to.
- **Do not report old problems.** A finding has to be about the change. You may open any
  file, touched or not, to confirm or disprove one: a claim the change makes about another
  file is checked by reading that file.
- **Do not stand in for a general review.** Logic bugs, performance and style are the
  editor's built-in review (`/code-review` in Claude Code), run before this one. Say in the
  report that you checked Substrat's rules only, so a clean result is not read as "no bugs".
- **Do not pad.** No finding is a valid result. A finding you could not tie to a quoted line
  is not one.
