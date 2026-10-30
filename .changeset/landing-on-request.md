---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
---

A connection landing can declare `bind: 'on-request'`: the connector pass then grants and binds nothing for it, so a scope can bind its own connection with its own options. Leaving `bind` out keeps today's behaviour (`every-install`), and the permission digest of a vertical that declares no on-request landing does not move.
