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

The promote review now shows what each migration declares it may lose. `substrat push` carries a migration's `moves` and `discards` beside its SQL, the control plane stores them with the version, and the dashboard's promote dialog, the console and `substrat promote` list every move as source → target and every discard with its reason, quoted as the author wrote it. A promote that discards data says how many places before anything else. A reason is shown as plain text, with bidirectional-control characters made visible, and a long one is cut behind "show all". A migration whose SQL is unchanged but whose declarations were edited after it shipped is listed apart as a declarations edit. Declarations join the version's migration digest only when a migration has any, so a version without them keeps the digest it had; adding, removing or rewording one asks for the migration acknowledgement at promote. They still do not change the digest a scope journals for the migration's SQL. A version pushed before this, or a migration declaring nothing, shows none. A discard with an empty reason is refused at the push boundary, and the CLI leaves the migrations off a push whose declarations it cannot carry, saying why, rather than failing the push.

The promote dialog, the docs and `substrat promote` no longer say a change to SQL migrations alone goes unrefused: since CLI 0.38.0 the registry refuses it, and only between two versions pushed by an older CLI does the dialog ask on its own.
