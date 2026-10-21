---
name: substrat-pr-preview
description: Guide a Substrat repository change through a hand-written published-package changeset, a pull request, a per-PR preview and cleanup, while presenting permission and migration diffs for human review. Use for the Substrat monorepo release workflow, not an app-only deploy or a vertical in another repository.
---

# Changeset → PR → preview in the Substrat repository

This workflow is for the Substrat monorepo. Read its `CLAUDE.md` and any applicable
`AGENTS.md` first. A preview exercises a vertical; it does not publish an npm package or
turn an app-only changeset into a release.

## 1. Prepare the reviewable change

- Run the applicable **root** `pnpm` scripts for this checkout, not a bare recursive
  workspace sweep. Re-emit every generated file touched by the change using its producer,
  then run that producer's `--check` form. In this repo, the relevant gates include
  `pnpm lint:permissions --check`, `pnpm lint:model --check`, and
  `pnpm lint:api --check`; inspect the diff they leave for review. Check the current
  `.github/workflows/ci.yml` for the remaining gates that apply.
- Review the published state in each affected package's `package.json`. A directory marked
  `"private": true` is not a published package. Write one hand-authored Markdown file in
  `.changeset/` whose frontmatter names **each affected published package** and its
  `patch`, `minor`, or `major` bump. Use the highest bump the public surface needs; explain
  the change below the frontmatter. For example, a change to two published packages:

  ```md
  ---
  '@substrat-run/kernel': minor
  '@substrat-run/adapter-sqlite': minor
  ---

  Explain the release-visible change.
  ```

  The `fixed` group in `.changeset/config.json` is contracts, kernel, adapter-sqlite,
  adapter-cloudflare, contract-tests, control-plane-api and vertical-host. A bump to one
  versions all seven together. **List the packages actually affected** with their correct
  bumps; do not create a second changeset to evade the group. These packages and engines
  need human bump judgement: `substrat changeset` computes a vertical's bump from emitted
  artifacts and does not judge their whole public surface. For an affected vertical,
  use `substrat changeset --check` as an additional check, never as the sole release review.
- If the diff changes only private apps or plugin documentation, do not claim it produces
  a release: an app-only changeset changes no published npm version, so the release gate
  will not move prod. Add an empty changeset only when the repo's current rules require
  one; otherwise omit it.
- Stage reviewed paths explicitly with `git add <path>...`, never `git add -A`. Before
  committing or opening the PR, inspect the staged diff and public text. Commits, PR
  titles and bodies, comments and changesets must not name consumers, real tenant, scope
  or app IDs, account IDs, or secret names. Describe the shape of a case instead.

## 2. Open the PR and present the two human checkpoints

After the local gates pass, push the branch and open a ready PR:

```sh
git push -u origin <branch>
gh pr create --base main --head <branch> --editor
```

Record its number. Give the reviewer the changeset and the generated diffs, the gates run,
and any manual checks. Check CI after each push and fix failures caused by the change.
**A CHECKPOINT PR is never merged by automation. The human reviews and merges it.**

1. **Permission checkpoint:** show the before/after `PERMISSIONS.md` diff and explain
   every changed key and role, especially who can now see another scope's data. A green
   `pnpm lint:permissions --check` proves the file is current, not that the change is
   acceptable. Mark this diff for human review before merge.
2. **Migration checkpoint:** show each new or changed migration in order, what happens
   to existing rows and whether a loss is declared. A green model or migration lint
   does not approve the data change. Mark this diff for human review before merge.

Do not acknowledge either checkpoint on the reviewer's behalf. Continue preparing the
preview while the human reviews; only the human merges after both applicable diffs have
been read.

## 3. Create or reuse the PR preview

Once the PR number is known, run this from the affected vertical's directory, after
confirming the intended workspace and vertical with the owner:

```sh
substrat preview create . --tag pr-<number>
```

The command pushes this tree, forks prod and prints the preview URL. Open that URL and
give it directly to the reviewer. Re-run the **same** command and tag after a PR push to
reuse the fork, bind the new version and renew its TTL; do not use `--refresh` unless the
review calls for a new fork from prod. The default TTL is **72 hours**. A long-lived
preview needs `--ttl none` and explicit deletion; ordinary PR previews should expire if
cleanup is missed. `substrat preview ls` shows active previews. If no changed vertical
can exercise the release, state that limitation in the PR rather than inventing a URL.

## 4. Reap on close

When the PR is merged or closed, run this from that vertical's directory:

```sh
substrat preview delete --tag pr-<number>
```

Deletion is idempotent. Check `substrat preview ls` and report that the preview is gone.
The human's review and merge remain the release decision; preview cleanup never stands in
for either checkpoint.
