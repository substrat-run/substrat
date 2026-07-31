---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': patch
---

Platform intents, Phase A: the `ctx.requestPlatform` primitive.

Adds the foundation from `docs/design/platform-intents.md` — the sandbox-clean way a vertical
asks the platform for a privileged action (provision a sibling scope, quota, …) without an
upward call. A vertical operation calls `ctx.requestPlatform({ kind, payload })` after its own
permission check; the kernel durably records a typed intent in this scope's new
`_substrat_platform_requests` spine table (atomic with the operation, stamped with the actor), and
returns the request id. The platform will pull and execute these with `HostAdmin` authority in a
later phase — knowing the tenant inherently because it reads that scope's own DO.

- `OperationContext` gains `requestPlatform(input): PlatformRequestId` (kernel), implemented
  symmetrically in both adapters; `contracts` gains `platformRequestId`, `platformRequestInput` /
  `platformRequest` schemas, and the `MAX_PENDING_PLATFORM_REQUESTS` backpressure bound (the verb
  refuses once a scope holds that many pending intents).
- **Migration checkpoint:** a new `_substrat_platform_requests` spine table is added to each
  adapter's `KERNEL_DDL` (`CREATE TABLE IF NOT EXISTS`, so it back-fills existing scopes on next
  open). No versioned module migration; it is kernel spine, flagged `system` automatically.
- Contract-suite coverage (both adapters): the intent is enqueued as `pending` with its kind /
  payload / actor, and rolls back with its operation when the handler throws (K-4).

No consumer yet — the drain-executor, router kick, and the Manyfold "New site" flow are later
phases (#358).
