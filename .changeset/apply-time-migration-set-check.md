---
"@substrat-run/kernel": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/docs": patch
---

A scope now checks, before it applies a pending migration, that the migrations its deployed code registers are the ones the platform stores for that version. The control plane derives one digest from the version's stored migrations and injects it into both uploads (the push and every serving upload) as the `SUBSTRAT_MIGRATIONS_DIGEST` binding. `migrationSetDigest` in `@substrat-run/kernel` computes it, and both adapters run it over every step the host registers, authored and kernel-derived. The pure host takes the same digest as its `migrationsDigest` option.

**Behaviour change:** a mismatch means the build that is deployed registers other migrations than its push declared. The scope then applies nothing and fails closed through the existing `migration failed for <module>@<version> — scope fails closed:` record. The record names both digests and the registered migrations (up to 20, then a count). The fix is to push again from the build that is deployed.

What is not checked: a scope with nothing pending, which never computes the digest; a version whose migrations the platform does not hold (`unheld:<id>`), which gets no binding; a script uploaded before this change, which gets the binding at its next serving upload; and a vertical on an adapter release from before this change. This is an integrity check that runs inside the deployed adapter, not an isolation boundary.
