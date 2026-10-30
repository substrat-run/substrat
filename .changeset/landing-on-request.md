---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

A connection landing can declare `bind: 'on-request'`: the connector pass then grants and binds nothing for it, so a scope can bind its own connection with its own options. Leaving `bind` out keeps today's behaviour (`every-install`), and the permission digest of a vertical that declares no on-request landing does not move. `substrat push` now sends each module's landings with the deploy manifest, and the control plane refuses a push whose registry disagrees with them about a landing's mode.
