---
---

`permission-diff --root <dir>` and `api-diff --root <dir>` target one project instead of the demos/+apps/ sweep, so the builder studio's standalone `permissions` and `api` gates are run rather than declared-and-skipped (#628). No published package changes — `tools/` is repo tooling and `@substrat-run/builder-workspace` is private.
