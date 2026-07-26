---
'@substrat-run/cli': minor
'@substrat-run/docs': patch
---

`substrat push` resolves its workspace from the project, never the machine: `--tenant` →
`SUBSTRAT_TENANT` → a `"substrat": { "tenant" }` pin in the vertical's `package.json`. The
machine-wide login default is deliberately out of the chain — the first push of a slug
**claims** `<workspace>/<slug>` for whatever workspace resolved (builder-plane.md §5), so a
stale global default silently pointing at the wrong workspace would claim the vertical for
the wrong owner.

A first interactive push with no pin lists your workspaces (whoami), auto-selects a sole
one, and offers to write the pin into `package.json` — repo-scoped, reviewable, shared with
every teammate and CI — so the question is answered once per project, not once per push. A
non-TTY push with no pin refuses with an actionable error instead of guessing. The push
line now prints the full target (`pushing acme-co/crm@0.1.0 …`) so the claiming workspace
is always visible; service-token pushes are unchanged (the platform actor has no
workspace). `promote`/`scope pull` keep the login-default fallback — ownership is already
checked server-side there.

`resolveAuth` gains `useDefaultTenant: false` and a `kind: 'session' | 'service'` field;
`readVerticalMeta` reads the new `substrat.tenant`; new `pinTenant(dir, tenant)` writes it
back preserving the file's indentation. Docs: CLI reference gets the full command surface
(`whoami`, `versions`, `publish`/`unpublish`, flagless `push` defaults table, first-push
transcript) and the deploying guide explains the per-project pin.
