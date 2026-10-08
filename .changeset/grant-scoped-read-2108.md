---
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/demo-shop': patch
---

Add `ctx.grantedEntities(permission, entityType, page)` (#2108). It pages checked entity ids from direct and org grants, following live parent edges to the checker's depth limit. Node grants return `all`; capability callers return an explicit `incomplete` result. A reverse tuple index supports bounded parent traversal. The shop uses complete grant pages to narrow its account read and portal order walk, retaining checked fallbacks when enumeration cannot finish within its local cap.
