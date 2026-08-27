---
"@substrat-run/contracts": patch
"@substrat-run/cli": patch
---

The generated deploy workflow builds a monorepo vertical's workspace dependencies before pushing. `pnpm install` only links a sibling package, and its `exports` point at a `dist/` a fresh checkout does not have — so the first hosted push of an in-repo vertical died in wrangler's bundle with `Could not resolve "@substrat-run/contracts"`. A monorepo workflow (`--path`) now carries a `Build workspace dependencies` step in both jobs: pnpm builds exactly the closure the package imports (`--filter "{dir}^..."`), yarn/npm build every workspace with a build script. A single-package repo is unchanged — it depends on published packages.
