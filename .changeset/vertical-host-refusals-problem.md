---
'@substrat-run/vertical-host': patch
---

`/internal` refusals ("this deployment cannot …", the `countOnly` 400) and the live-read refusals (426, 501, 403, 401) answer `application/problem+json` problem documents instead of `application/json` `{ error }`. Statuses and the `error` sentence are unchanged, and the live refusals keep their `x-substrat-live` header.
