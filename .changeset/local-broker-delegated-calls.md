---
'@substrat-run/adapter-sqlite': minor
'@substrat-run/dev-issuer': minor
---

The local vertical broker carries a call made for a person (`onBehalf`), admitted by the target's own door and run as that person under the token's scope while the caller passes the target's peer admission, refused in the hosted door's words (the reason goes to a `peer-on-behalf-refused` log line), and answers `substrat.peer-client` with the target's client id; the dev issuer's harness adds `devPeople(…).delegated` (capped to the `delegations` it is given), `devDelegate` and `devRefreshStore`, so a master app calls its plugin as the signed-in person on dev servers (#3161).
