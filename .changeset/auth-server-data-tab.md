---
'@substrat-run/demo-auth-server': minor
'@substrat-run/control-plane-api': patch
---

The dashboard Data tab works for Auth Server apps ("Couldn't load the database — internal error").

**auth-server** now implements the §5.4 introspection verbs (`GET /internal/tables`,
`GET /internal/tables/:table`): the issuer DO's Better Auth SQLite is a real per-scope
database, and it answers the same two table-shaped, platform-gated reads a ScopeDO does.
Secret-bearing columns are redacted inside the DO before anything crosses its boundary —
password hashes, session tokens, OAuth tokens/client secrets, JWKS private keys, and the
issuer's own signing secret (`config.value`, which also carries delivered `cfg:` entries
such as ADMIN_PASSWORD) all come back `[redacted]`; ids, emails, timestamps and row
counts stay readable.

**control-plane-api**'s error boundary now passes a `ControlPlaneError` through verbatim
(status + message) instead of collapsing it into the generic 500 "internal error". A
vertical's honest refusal — e.g. a 501 for a verb it does not implement — reaches the
dashboard as itself; routes that already hand-caught it are unchanged.
