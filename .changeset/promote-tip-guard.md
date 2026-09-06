---
'@substrat-run/contracts': minor
---

The generated deploy workflow can no longer point prod at older code when its queue
resumes out of order (#1216). GitHub serializes the `substrat-deploy-<slug>-prod`
concurrency group but explicitly does not order it, so a run holding an older commit
could resume after a newer one had already promoted — and because `substrat push`
patch-bumps without reading the commit, prod would then serve the older code under a
*higher* version number, with nothing in the dashboard or admin log saying so.

The workflow now splits the push from the pointer move and guards between them: the
version is uploaded as before (findable, migrations rehearsed), and the promote runs
only while the run still owns the release coordinate — the branch tip in trunk mode,
the version the tip's package.json declares in changesets mode (a changeset-only merge
moves the tip without releasing, so a commit check there would leave a release pushed
but never promoted). A superseded run skips the promote with a loud `::warning::` and
exits green; the tip commit's own run owns the pointer. The trade is deliberate: if
that newer run then fails, the superseded merge landed with no promotion at all, and
prod holds until the next green merge — prod never goes backwards, at the price that a
merge may not promote. The guard reads the tip through the GitHub API with the default
read-only token, right before the promote, so the race window is two commands rather
than the length of a build.

Existing repos pick this up the next time the workflow is regenerated (`substrat init
--ci github`, or the dashboard's one-click CI setup).
