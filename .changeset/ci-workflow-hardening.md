---
'@substrat-run/contracts': patch
---

The generated deploy workflow gets three fixes, so every project scaffolded with
`substrat init --ci github` (and every one the dashboard's one-click CI writes) gets them too.

- **A read-only default `GITHUB_TOKEN`.** There was no workflow-level `permissions` block, so
  in a repository whose default is read/write, every job held write access to contents, issues
  and packages while none of them writes anything. `contents: read` at workflow scope; the
  `preview` job keeps elevating itself to `pull-requests: write` for its comment.
- **Prod promotions are serialized, and none is dropped.** The deploy job had no concurrency
  group, so two merges landing together raced and the loser could point prod at the OLDER
  version — a channel takes whichever push finishes last, not whichever commit is newer. Queued
  rather than cancelled: a cancelled push can leave a version uploaded but never promoted. The
  group carries `queue: max`, because the default holds only one run pending — three merges
  landing together would evict the middle one, and that commit would never deploy at all. The
  comment says what that buys and what it does not: runs are serialized and none is dropped,
  but GitHub does not guarantee the order pending runs resume in, so two inverting still leaves
  prod on the older commit.
- **`SUBSTRAT_TEST_SCOPE_ID` reaches bash through `env`.** It was interpolated into the script
  text, where shell syntax in the value would execute — beside a live `SUBSTRAT_SERVICE_TOKEN`.
  A repository variable is set by a maintainer rather than a stranger, which lowers the odds
  and not the rule.
