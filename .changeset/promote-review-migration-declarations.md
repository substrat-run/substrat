---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/contract-tests": minor
"@substrat-run/cli": minor
"@substrat-run/dashboard-web": minor
"@substrat-run/console": patch
---

The promote review now shows what each migration declares it may lose. `substrat push` carries a migration's `moves` and `discards` beside its SQL, the control plane stores them with the version, and the dashboard's promote dialog, the console and `substrat promote` list every move as source → target and every discard with its reason, quoted as the author wrote it. A promote that discards data says how many places before anything else. Everything the review shows from the version (reasons, table and column names, migration ids and their SQL) is plain text with every control, format and bidirectional character made visible as `<U+XXXX>`, so nothing a vertical wrote can drive a terminal or reorder what is read; a long or many-line reason is cut behind "show all", and the count says "at least" when the list is cut. A migration whose SQL is unchanged but whose declarations were edited after it shipped is listed apart as a declarations edit. Declarations join the version's migration digest only when a migration has any, so a version without them keeps the digest it had; adding, removing or rewording one asks for the migration acknowledgement at promote. They still do not change the digest a scope journals for the migration's SQL. A version pushed before this, or a migration declaring nothing, shows none. A discard whose reason is empty once whitespace and invisible characters are removed is refused at the push boundary and by the kernel's data-loss fence alike (the fence used to accept a reason of only zero-width characters), a declaration naming `__proto__`, `constructor` or `prototype` is refused, and the CLI leaves the migrations off a push whose declarations it cannot carry, saying why, rather than failing the push.

The promote dialog, the docs and `substrat promote` no longer say a change to SQL migrations alone goes unrefused: since CLI 0.38.0 the registry refuses it, and only between two versions pushed by an older CLI does the dialog ask on its own.
