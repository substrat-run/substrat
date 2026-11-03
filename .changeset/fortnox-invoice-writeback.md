---
'@substrat-run/connector-fortnox': minor
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
---

Fortnox invoice bindings can write decisions back with `options.writeback`: the sweep asks the vertical what is waiting, keeps undecided invoices from being paid, books the approved ones and adds to the comment log.
