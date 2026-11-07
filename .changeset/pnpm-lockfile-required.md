---
'@substrat-run/cli': patch
'@substrat-run/contracts': patch
---

`substrat push` and `substrat preview create` refuse a source with no `pnpm-lock.yaml` before uploading, and the generated deploy workflow installs with pnpm alone, because the platform's build does.
