---
'@substrat-run/kernel': patch
'@substrat-run/contract-tests': patch
'@substrat-run/demo-ticket0': patch
---

- ticket0: each widget chat's public messages now hang once under a per-conversation public thread, and the thread hangs under the visitor sessions on that conversation. A visitor writing into a closed chat moves their session with two edge changes, however long the old thread is; before, there was one per message. Each public message holds two edges, however many chats were merged into its conversation. The widget's live feed is unchanged: it still nudges only about the visitor's own public thread. Migration 0026 converts existing desks.
- kernel: `ctx.relink` onto a parent the child already has is now part of the documented contract. It detaches `from`, leaves `to` as it was, keeps every other parent, and records one `entity.relinked`. The contract suite holds both adapters to it.
