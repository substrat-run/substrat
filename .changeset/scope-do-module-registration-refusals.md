---
'@substrat-run/adapter-cloudflare': patch
---

A ScopeDO now refuses a module list that registers one module id twice, or a module that withdraws an operation it binds itself, with the messages the pure host and the coordinator already give. Both used to start: the duplicate silently replaced the first registration's record, and the self-withdrawal unbound the module's own handler.
