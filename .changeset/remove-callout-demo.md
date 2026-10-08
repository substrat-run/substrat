---
'@substrat-run/dashboard': minor
'@substrat-run/dashboard-web': patch
'@substrat-run/console': patch
'@substrat-run/docs': patch
---

The Callout demo vertical is removed. The dashboard catalog no longer offers Callout:
its builtin row is retired the way Meridian's and Manyfold's were — installs are blocked
and it is unlisted, while any existing app keeps serving. Locally, `pnpm dev` now runs
the standalone control plane and the console; `pnpm dev:connected` and
`pnpm callout-demo` are gone. The docs no longer describe Callout as a demo; its original
concept and test-run spec are kept as historical RFCs.
