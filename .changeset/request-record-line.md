---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/contract-tests': minor
---

The invocation log line is now a per-request record (#1746). Alongside tenant, scope, status and duration it carries the request's level, the operation that ran, the kernel problem code of a failed call, which kind of subject it ran as, the version that served it, and the event types and entities the operation itself emitted. Every field is additive; an unfilled one is `null`, never a guess.

Two kernel surfaces make that possible. `ScopeStub.subjectKind` names the kind of subject a stub acts as (`principal`, `connection`, `system`, `capability`, `vertical`), decided by the door that minted it. `InvokeOptions.onEmitted` reports, after a commit, the events the operation emitted — not its consumers', not a rolled-back sub-transaction's, and nothing for a failed call or an idempotent replay. Both adapters pass the new `emittedReportContractSuite`.

MCP tool calls now fill in the same record and stamp their events with the invocation id, as HTTP operations already did. A vertical picks all of this up by updating its Substrat packages and re-pushing; no code change is needed.
