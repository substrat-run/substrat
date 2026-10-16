---
"@substrat-run/kernel": minor
"@substrat-run/cli": minor
---

`substrat push` now checks your migrations for data loss before it uploads. It replays them, in the order a scope applies them, against an in-memory scope where every table holds a row and every column a value, through the data-loss fence in your own `@substrat-run/kernel`. A migration that would lose rows or values without declaring it (`moves` / `discards`) refuses the push with the fence's message, instead of failing every populated scope closed at promote. `substrat push --check` runs the same check. Each declared move and discard is printed with its reason, and the push's summary line says how the check went.

The check needs `node:sqlite` (Node 22.13 or later). It builds the platform's `_substrat_*` tables from your `@substrat-run/adapter-sqlite` when one is installed. When it cannot run (no SQLite, a kernel without the replay, or a migration whose SQL cannot run on made-up values), the push goes ahead and prints `data-loss check: SKIPPED` or `INCOMPLETE`, including how many migrations went unchecked. The fence still refuses at promote. To make those outcomes refuse the push too, pass `--require-data-loss-check` or set `SUBSTRAT_REQUIRE_DATA_LOSS_CHECK=1`.

The kernel exports `replayMigrations` and `MIGRATION_REPLAY_API`, the replay `pnpm lint:migration-fence` already ran, now in one place.
