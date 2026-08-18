---
'create-substrat': patch
---

The design interview now decides the auth seam, and the deploy step tells the truth
about assets and versioning.

Three corrections to the build flow, all of them things a vertical got wrong *after*
the design was approved, which is the expensive place to find out.

**Auth.** The playbook offered to "wire a real login" with a credential-store pattern
the reference verticals no longer use. The vertical is a pure OIDC relying party:
a separate issuer, `@substrat-run/vertical-auth`, `IdentityDO` bound as a third DO
store, `substrat:auth` config read per scope. The trap worth stating at design time is
that the dashboard wires identity **only at app creation** — an install made without
that choice stays unwired forever, and a worker whose `authenticatedPrincipal` returns
null answers 401 to everything, however many auth servers the team has.

**Assets.** A SPA is declared in `runtimeNeeds.assets` and served from the edge
without invoking the worker. Base64-inlining a built `app/dist` into a generated
worker module costs ~+33 % script size and a worker invocation per image.

**Versioning.** `substrat push` defaults to the registry's highest semver,
patch-bumped — `package.json`'s version is only a seed for the first push of a new
slug. Left alone, the registry and `package.json` drift apart within a few deploys, so
the release script lets changesets own the version and passes it with `--version`,
read via `node -p` *after* `changeset version` has rewritten the file (not
`$npm_package_version`, which was captured before it).
