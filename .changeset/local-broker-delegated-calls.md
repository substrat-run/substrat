---
'@substrat-run/adapter-sqlite': minor
'@substrat-run/dev-issuer': minor
---

The local vertical broker carries a call made for a person (`onBehalf`), admitted by the target's own door and run as that person under the token's scope, and answers `substrat.peer-client` with the target's client id; the dev issuer's harness adds `devPeople(…).delegated`, `devDelegate` and `devRefreshStore`, so a master app calls its plugin as the signed-in person on dev servers (#3161).
