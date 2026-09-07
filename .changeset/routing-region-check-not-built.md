---
'@substrat-run/contracts': patch
---

Comment-only. `hostnameRegion`'s docblock claimed the router detects a contradiction
between a hostname's region and its scope's jurisdiction and refuses the request.
Nothing does that (#958): the resolved route target carries no jurisdiction to compare
against — neither adapter's hostname read joins `scopes.jurisdiction` — and the router
declines the comparison in its own comment. The docblock now says the column records a
region for a check that is specified and not built, so a reader does not take an
unimplemented refusal for a shipped one. No schema or runtime change.
