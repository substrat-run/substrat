---
'@substrat-run/dashboard': patch
---

The generated GitHub deploy workflow installs dependencies before pushing.

One-click deploy setup committed a workflow that ran `substrat push` on a bare
checkout — wrangler's custom build (the repo's own `tsc`) then failed on missing
devDependencies, the first push never landed, and the vertical silently never
appeared (registration happens on first successful push). The workflow now
installs from the repo's lockfile (pnpm/yarn via corepack, `npm ci`, `npm install`
fallback) and runs on Node 22 — corepack floats to latest pnpm for repos without a
`packageManager` pin, and pnpm 11 needs Node ≥ 22.13. The generator moved to
`github.ts` so the committed file, the manual copy-paste path, and the tests all
share one source.
