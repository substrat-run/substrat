---
'@substrat-run/contracts': patch
---

The generated deploy workflow gets three fixes, so every project scaffolded with
`substrat init --ci github` (and every one the dashboard's one-click CI writes) gets them too.

- **A read-only default `GITHUB_TOKEN`.** There was no workflow-level `permissions` block, so
  in a repository whose default is read/write, every job held write access to contents, issues
  and packages while none of them writes anything. `contents: read` at workflow scope; the
  `preview` job keeps elevating itself to `pull-requests: write` for its comment.
- **Prod promotions are serialized.** The deploy job had no concurrency group, so two merges
  landing together raced and the loser could point prod at the OLDER version — a channel takes
  whichever push finishes last, not whichever commit is newer. Queued rather than cancelled: a
  cancelled push can leave a version uploaded but never promoted.
- **`SUBSTRAT_TEST_SCOPE_ID` reaches bash through `env`.** It was interpolated into the script
  text, where shell syntax in the value would execute — beside a live `SUBSTRAT_SERVICE_TOKEN`.
  A repository variable is set by a maintainer rather than a stranger, which lowers the odds
  and not the rule.
