---
"create-substrat": patch
"@substrat-run/psl": patch
"@substrat-run/boundary-lint": patch
"@substrat-run/engine-invites": patch
"@substrat-run/connector-scrive": patch
---

docs: every package has a README, and the one on npm stops lying about the initializer

`create-substrat`'s published README said "The initializer is not released yet. This package
prints a pointer to the docs and exits. It does not scaffold anything." That has been false
since the template landed — `index.js` copies the full template tree and generates
`package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` and a project README. The
text on npm was telling readers the entry point to Substrat doesn't work. It also instructed
`pnpm add … zod`, contradicting the rule the same package's generated `package.json` comment
states — Zod schemas don't compose across copies, so `z` comes from `@substrat-run/contracts`
and zod is never installed directly.

- **Every package now has a README**, including the three that were public on npm without one
  (`vertical-auth`, `oidc-rp`, `psl`) and the monorepo-internal `engine-test-kit` and `ui`.
- **Every README links substrat.net** — `boundary-lint`, `vertical-host`, `engine-invites` and
  `connector-scrive` each gained the documentation pointer in the shape its README already
  used.
- **The docs site covers the package list**: new `/reference/vertical-auth`, `/reference/psl`
  and `/reference/create-substrat` pages, all three in the sidebar.

README-only for the packages listed here; a patch is what carries the corrected text to npm.
`vertical-host`'s README changed too but is deliberately not bumped — it is in the `fixed`
group, and a documentation link is not worth a seven-package lockstep release. It ships with
that group's next version.
