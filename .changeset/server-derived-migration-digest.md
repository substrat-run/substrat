---
"@substrat-run/contracts": patch
"@substrat-run/kernel": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/contract-tests": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/cli": patch
"@substrat-run/docs": patch
---

The control plane now derives a version's migration digest itself, from the migrations it stores for the version (with their declared moves and discards) and the store classes in its manifest, instead of storing the digest the push sent. The promote gate, the bind snapshot and the lineage rebind compare the derived value, so a push can no longer present the live version's digest over different migrations. `migrationDigestOf` in `@substrat-run/contracts` is the one implementation: `substrat push` hashes with it, and the control plane re-derives with it.

**Behaviour change, at push:** a push that carries its migrations under a digest that is not theirs is refused before anything is uploaded (`validation_failed`, reason `migration_digest_mismatch`), on `/verticals/:slug/deploy` and on the raw version publish alike. A CLI whose push digest covers the SQL and its declarations is unaffected. One from before the SQL entered the digest is refused, and the refusal says to upgrade the CLI.

**Behaviour change, at promote:** a version whose manifest carries no migrations has nothing to derive a digest from. That covers a version pushed before manifests carried them, one whose SQL is over what a manifest carries, and one with no manifest. It is stored as `unheld:<version id>`, which equals no other version's digest, so every promote to or over it asks for the migration acknowledgement, and the refusal says why. Before this, such a version was compared by the digest its push sent.

Versions stored before this change keep the digest their push sent until it is derived. Each directory re-derives them: the Durable-Object directory in bounded batches on its backfill alarm, and both adapters on any read of a version the backfill has not reached yet, so no gate compares a pushed digest in the meantime. A restore of a dump taken before is derived again the same way.
