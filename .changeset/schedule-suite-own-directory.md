---
'@substrat-run/contract-tests': patch
---

The schedule contract suite's sweep tests run on vitest's default timeout again. The 30-second allowance covered a sweep that walked every other test file's scopes on the Cloudflare adapter's shared test directory. That harness now gives the suite a directory of its own.

The directory-restore test now checks its own audit entry by actor and action, and no longer reads a fixed window of the whole log. It passes however many rows other suites wrote to the directory first.
