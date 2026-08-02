---
'@substrat-run/cli': patch
---

A stale workspace build now says so instead of failing confusingly (#386). In the
monorepo the `substrat` bin is a symlink into `packages/cli/dist`, and after a pull that
touched `src/` without a rebuild, the stale dist failed in misleading ways (a Zod
refusal of `registry: undefined` after the field became required). Every command now
checks src-vs-dist mtimes at startup and warns with the rebuild command when the build
is older than its sources — a no-op for an npm-installed CLI, whose tarball ships no
`src/`. And a deploy-manifest schema refusal at push now names the likely cause (stale
build or outdated CLI) instead of printing a bare Zod issue list.
