---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': minor
---

A scope no longer skips a migration whose SQL differs from the one it already applied under the same version (#2066). The migration journal (`_substrat_migrations`) gains a `sql_digest` column on both adapters: the SHA-256 of the exact SQL that ran. Existing scopes get the column on their next wake.

When a module's authored migration is already applied with a different digest, the scope fails closed the way it does for a migration that throws. The error names the module, the version and both digests, and the directory records it as the scope's migration failure. To recover, rebuild the scope or restore it to a dump taken before the other SQL ran. Re-numbering the migration does not help, because the scope still holds the other SQL under the old version.

A journal row applied before the column carries the mark `legacy` instead of a digest, and is accepted; it is never backfilled with one. A trigger on the journal refuses any row written or rewritten without a digest, so an instance still on an older release fails its migration loudly instead of recording one, and a restore whose dump carries a NULL digest is refused (a dump exported before the column restores as `legacy`). A dump whose journal DDL and columns disagree about `sql_digest` is refused. Migration SQL may not name the journal, and an authored migration may not write the spine at all (no write, DDL or same-named TEMP object on any `_substrat_*` table), except four shipped, reviewed ticket0 migrations, allowed by their exact digest. Kernel-derived DDL (search, list and archive/trash migrations) is versioned by its declaration and is not held to its digest, so a kernel release that changes how it writes the same declaration does not fail scopes closed.

The kernel exports `migrationDigest`, `migrationSteps`, `planMigrations`, `migrationDivergence`, `migrationFailedError`, `assertMigrationSql`, `assertJournalDumpCoherent`, `assertNoJournalSql` and the journal fence and legacy-mark statements, which both adapters plan their migration pass through. `@substrat-run/contract-tests` adds `migrationDigestContractSuite`.
