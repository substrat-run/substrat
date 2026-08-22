---
'@substrat-run/boundary-lint': minor
'create-substrat': patch
---

R2 bans `cloudflare:workers` in module code — the ambient env is not a capability (#862).

Every capability module code holds is meant to arrive on `ctx`, and the scope boundary was
described as physical on that basis: `ctx.sql` is closed over one scope's storage, so no SQL
string a module composes can reach another scope's database. That half is true. The other
half was not enforced.

`cloudflare:workers` exports an **ambient** `env` — `export const env: Cloudflare.Env` in
`@cloudflare/workers-types`, confirmed by probe under the repo's own workerd test pool, which
returned the full binding list (`SCOPE`, `CONTROL_PLANE`, …) to a module that was passed
nothing. So one import hands module code every binding and secret the vertical's script
declares, including its own `SCOPE` namespace:

```ts
import { env } from 'cloudflare:workers';
env.SCOPE.get(env.SCOPE.idFromName(someOtherScopeId));  // another tenant's scope
```

That is the one import that turns the scope boundary from physical into advisory, and it is
sharper for engines than for verticals: an installed engine — the layer whose whole job is
owning invariants — could reach every scope of the vertical that composed it.

It belongs to R2 rather than a new rule for the reason `node:*` does: a capability the host
owns and injects, imported behind the host's back. Numbering is untouched, so #786's
`catch`-outside-`ctx.atomic` rule keeps R7.

Harness code is exempt exactly as it is for `node:*` — `worker.ts` and `*-do.ts` are where
`DurableObject` legitimately comes from, and every such file in this repo stays green
(`boundary-lint: all layer rules hold`).

**This is a lint, and lint is not containment.** It runs in this repo's CI and in a
vertical's own, not on the hosted push path, so for third-party code it raises the floor
rather than closing the hole. Whether the layer rules should run platform-side at
push/admit — over the built bundle, where obfuscation is harder — is the open question this
change does not answer.
