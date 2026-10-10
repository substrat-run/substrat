---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
'@substrat-run/dashboard-web': patch
---

**Breaking:** `ctx.platformRequests` now returns `PlatformRequestEntry[]` instead of `PlatformRequest[]`. A journal row whose id, kind, status, attempts or time does not decode comes back as an `UndecodablePlatformRequest` beside the other rows, where it used to make the whole read throw (#1637).

This is `minor` rather than `major` because the fixed group is 0.x. In 0.x semver, a minor bump is where a breaking change goes, and `major` would mint 1.0.0. Every package in the fixed group moves to the same version.

**What a vertical changes.** Narrow before reading any other field:

```ts
import { isUndecodablePlatformRequest } from '@substrat-run/contracts';

for (const r of ctx.platformRequests({ kind: 'connector:scrive' })) {
  if (isUndecodablePlatformRequest(r)) continue; // or show r.decodeError
  r.status; // 'pending' | 'done' | 'failed', as before
}
```

The variant names the row without carrying it, in the same grammar as `withheldEvent`. It holds the five identity columns as they are stored, as text (`null` for SQL NULL), and `decodeError` names every column that did not decode. It carries no payload, requester, result or error text. A healthy journal never returns one. Only a restored dump can hold such a row, because `ctx.sql` refuses writes to `_substrat_*` tables.

- **Reads:** `ScopeHost.listPlatformRequests` and `listPlatformRequestHistory`, the vertical-host routes and `VerticalClient` return the same union.
- **Drain:** it never runs a handler on the variant.
  - When the stored id is still an id, the drain settles the row `failed` (`validation_failed`, platform origin), as it already does for a row whose JSON did not decode.
  - When the stored id is not an id, nothing can settle the row. The drain leaves it pending, reports it as `PlatformDrainReport.unsettleable` and drains the rest of the queue past it.
  - That row keeps one of the scope's 32 pending slots until an operator repairs it.
- **Sweep:** `platformRequestDrainTotals` gains `unsettleable`, defaulted to 0 so stored rows still parse. While the count is above zero, the fleet `platform-request` sweep row is `failed`, and the control plane logs each scope as `platform-request-unsettleable`.
- **Dashboard:** the integration drawer shows such a row as **Unreadable**, with the columns that broke. It used to show an empty list.
- **Kernel internals:** `rowDecoder` gains `finishOr`, and `platformRequestOf` returns the union.
