---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
---

Permission evaluation is one implementation again. The kernel now owns the four-rule
tuple algebra (`createTupleEvaluator`), and each adapter supplies only a
`PermissionTupleReader` — where its tuples live and how they are read. Behaviour, proofs
and both adapters' public surfaces are unchanged.
