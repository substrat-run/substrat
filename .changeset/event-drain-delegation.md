---
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

The Tier-2 drain reaches the deployment that actually holds a scope's outbox (#1334).

The shared control plane's own `SCOPE` namespace is the module-less placeholder — a hosted scope's events live in its vertical's dispatch deployment. So a drain over the platform's own namespace, which is what binding the sink alone would have run, constructs one empty placeholder DO per active scope per tick, writes an access row for each, and ships nothing: from the lake's side, a fleet with no events.

`CloudflareScopeHost` gains an `eventDrainDelegation` option on the model of `connectorDelegation`: when it is set, `readUndrainedEvents` and `markEventsDrained` go to the serving deployment, and the access row and the `drainEvents` admin receipt are written on the platform host either way, so an auditor cannot tell which branch served a read from the row it left (K-24). The far end is two new required members of `VerticalScopeHost` — `undrainedEventsLocal` and `markEventsDrainedLocal`, both implemented by the adapter — behind `GET /internal/undrained-events` and `POST /internal/mark-drained` on the platform-gated surface, with `VerticalClient.undrainedEvents` / `markEventsDrained` as the calls. The read is bounded at the door (a `limit` above 1000 is a 400), and the stamp carries the platform's instant through so its receipt and the rows agree.

The control plane wires the delegation beside the connector one and binds the sink only when it can also reach a vertical: a deployment without `DISPATCH` / `PLATFORM_SECRET` keeps the drain phase skipped rather than running it over placeholders. A scope whose vertical has no serving deployment is recorded as an `event-drain` error for that scope and stepped over — silence is the failure mode this seam exists to remove, so it is not answered with "nothing".
