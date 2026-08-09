---
"@substrat-run/contracts": minor
"@substrat-run/cli": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/contract-tests": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/dashboard": patch
---

feat: every pushed version records where its code came from — git CI or a terminal

A git-connected deploy and a `substrat push` from a terminal were
indistinguishable on the platform: the generated deploy workflow runs the same
CLI against the same endpoint, so the dashboard could not answer "where did the
code this app is serving come from". Now the CLI self-reports its context with
each push and the dashboard shows it:

- **Contracts**: `versionOrigin` on the version record — `source: 'git' | 'cli'`
  plus `gitRepo`/`gitCommit`/`gitRef` when pushed from CI. A label, never
  authority: nothing gates on it, and a version pushed before tracking (or by an
  old CLI) reads back `null`.
- **CLI**: `substrat push` detects the GitHub Actions runner and attaches the
  repo, commit, and branch it built from; a terminal push sends `{ source: 'cli' }`.
- **Control plane**: the deploy route parses the field leniently — a missing or
  malformed origin must never fail a push — and both adapters store it as a
  nullable `origin_json` column on the version row.
- **Dashboard**: an origin tag (git-branch icon + `repo@sha` linking to the
  GitHub commit, or a terminal icon + `cli`) on every version row on the
  Verticals page, in the per-app Deployments tab, and beside the app's Running
  version.

The vertical-level `source` field is deliberately untouched: it is
claim-at-first-push metadata, and one app legitimately receives both kinds of
push — provenance is per version.
