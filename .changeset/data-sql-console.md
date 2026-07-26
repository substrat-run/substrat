---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
---

The Data tab grows a SQL console (#219): `HostAdmin.queryScope` runs ONE read-only SQL
statement against a scope's own database, next to the table-shaped reads that stay safe
by construction. User SQL reaching the DB moves the safety to statement-level
enforcement, in two layers shared across adapters:

- the kernel's `assertReadOnlyQuery` — a comment/string/identifier-aware token scan
  that rejects multi-statement input, a first keyword outside SELECT/WITH/VALUES/
  EXPLAIN, and any bare write/DDL/session verb anywhere (`WITH … INSERT INTO` is valid
  SQLite, so the first keyword alone proves nothing); deliberately over-strict, since a
  false positive costs a quoted identifier and a false negative forges the spine;
- an adapter-authoritative backstop: better-sqlite3's `prepare().readonly`
  (sqlite3_stmt_readonly) on the pure adapter, and a transaction that ALWAYS rolls
  back inside the ScopeDO, whose `exec` has no read-only flag.

Results are positional rows capped at `SCOPE_QUERY_ROW_MAX` (200) with a `truncated`
flag — a ceiling, never an error. Same K-3 (tenantId, scopeId) cross-check and K-24
access log as the table reads; the logged argument is the SQL itself. The refusal
message prefix (`read-only console:`) is contract — pinned by the shared suite against
both adapters and mapped to 400 by the transport.

Transport: `POST /tenants/:tenantId/scopes/:scopeId/query` with the same
vertical-delegation as the table reads (`VerticalClient.queryScope` →
`/internal/query`); a vertical that cannot answer safely refuses with its own status,
relayed verbatim — auth-server keeps refusing via its `/internal/*` 501 catch-all,
because its DO redacts secret-bearing columns on table reads and arbitrary SQL would
walk around the redaction. Editing rows stays out of scope forever: a write here would
bypass the event log and forge the spine.
