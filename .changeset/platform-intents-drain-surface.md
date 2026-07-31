---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': patch
---

Platform intents, Phase B1: the drain surface (read + settle).

Adds the read/settle half of the platform-intent queue from `docs/design/platform-intents.md`, so
the platform can pull a scope's pending intents and journal their outcome. `ScopeHost` gains
`listPlatformRequests(tenantId, scopeId)` (pending intents, mapped to the `PlatformRequest`
contract shape) and `settlePlatformRequest(tenantId, scopeId, id, { status, result, lastError })`
(mark `done` / `failed` / `pending`-for-retry). Both are fleet-maintenance (no actor), the same
class as `drainDue`, implemented symmetrically in both adapters (a `pendingPlatformRequests` /
`settlePlatformRequest` DO RPC pair on the Cloudflare scope DO; direct table reads/writes on the
SQLite adapter).

`result` is COALESCE'd on settle, so a value written on an earlier pass (e.g. a minted sibling
scope id for two-phase idempotency) survives an omitted one on retry. Contract-suite coverage on
both adapters: list-pending → settle-done → drops from pending with its result recorded, and a
transient `pending` retry preserves the two-phase result.

No cross-deployment execution yet — the `VerticalClient` `/internal/platform-requests` transport,
the kind→handler drain engine, `provision-sibling`, and the sweep wiring are Phase B2 (#358). The
key constraint driving that split: the control plane can't read a vertical's scope DO directly
(different deployments — the reason the CP sweep runs `drainRetries: false`), so B2 drains over the
vertical's `/internal/*` HTTP surface, exactly like Data-tab introspection.
