---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

The storage gauge samples scope stores. Each binding's size is kept beside the scope database, one row per day, and `/meters` adds it up when a sample exists. The sweep reads them on the same pass as the database, at most once a day, and retention drops them on the same horizon. A day that measured no store at all is recorded, so a version that drops its last binding stops being billed for it. A deployment that cannot read store sizes is not counted as failing, and one scope's store read is bounded by a deadline, so a hung store fails that scope rather than the whole pass.
