---
'@substrat-run/control-plane-api': patch
---

`GET /connections/health`'s free-text `q` filter no longer substring-matches a connection's or tenant's id. Ids are Crockford-base32 ULIDs — a short, common needle can land inside one by chance, and two ids minted in the same millisecond share a monotonic prefix, so one hit there matched every row born that millisecond (#1716). `q` now matches only the fields the console's search box promises — provider, vertical, label, account and last error — plus an exact, whole-id match (case-insensitive) so pasting a connection id still finds its row.
