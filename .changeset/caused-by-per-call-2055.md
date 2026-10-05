---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': minor
---

An executor's event now appears in the audit trail only on the admin rows that executor writes (#2055). Both adapters used to keep the event in a field on the host, set before the handler's `await` and cleared after it. Any other admin call the host handled while the handler was suspended, a staff call included, was recorded with `causedBy` pointing at an event it had nothing to do with. This happened on SQLite and on the Cloudflare coordinator alike.

The handler now gets an `admin` (and a connector context) bound to its own event, made as a view of the host the way `attributed` is. The host itself never carries a cause. `ScopeHost.attributed(onBehalfOf, { causedBy })` takes the event as an optional second argument, for a handler that attributes its writes to a person through the host, as the membership executor does. The kernel exports `attributedView(host, { onBehalfOf?, causedBy? }, buildAdmin)` for a host that builds such views. `attributedHost` is unchanged.

A consumer's own emits name the event it consumed through its context now, on both adapters, rather than through a field on the scope. Within one scope this was already safe, because each adapter serializes a scope's emitting work. The cause no longer depends on that.

`@substrat-run/contract-tests` adds `causedByContractSuite` (executor, in-process connector, routed `dispatchConnector`) and `scopeCausedByContractSuite`, with the `causedByMod` fixture whose consumer can be held mid-handler.
