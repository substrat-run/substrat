---
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/contract-tests": patch
---

A scope's applied-migrations list is no longer cut off at 100 rows (#2553). `scopeAppliedMigrations` answered with the newest 100 and said nothing about the rest, so a scope carrying more migrations than that showed an incomplete schema history, and a test fixture that pushed the shared scope past the cap broke the case reading `appliedAt` back. Both adapters now return every row, newest first. The contract suite gains `manyMigrationsContractSuite` and a fixture module (`manyMigrationsMod`) whose 120 migrations exceed the old cap on their own, so every scope in the kit now reads back more than 100 rows.
