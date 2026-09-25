---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/contract-tests': minor
---

The node adapter now enforces the SQL limits a Durable Object enforces on `ctx.sql`, so a vertical's own test suite fails where production would. Measured on a real Durable Object: **5** terms in one compound `SELECT`, **100** bound parameters, **100 000** bytes of statement, and the 50-byte `LIKE` pattern that was already covered. A statement over one is refused with the hosted message (`too many terms in compound SELECT`, `too many SQL variables at offset N`, `statement too long`). A multi-row `VALUES` list is not limited. The values are exported as `DO_SQL_LIMITS`, with `assertWithinSqlLimits` and `guardSqlLimits`, and documented on `ctx.sql` and in the scope-host concept page. Only module-facing SQL is judged.

Also fixes a paged read whose set filter (`filters: { status: [...] }`) bound one parameter per member, plus the cursor and page size: past about 97 members it failed on a Durable Object and ran on node. The set is now one bound JSON array. `contract-tests` gains `sqlLimitsContractSuite`, which drives the same statements through both adapters and compares the refusals.
