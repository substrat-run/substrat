---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/vertical-host": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/control-plane": patch
---

A hosted vertical's connector deliveries now go out within seconds of the commit, and a large backlog drains instead of being dead-lettered (#3365). Routed connector deliveries have a room of their own (`MAX_PENDING_CONNECTOR_DISPATCHES`), so module intents and sweep reports no longer take their slots. A delivery that finds the room full is no longer counted as an attempt. It stays due, and the scope asks for a drain. The control plane runs a kicked drain in a per-scope object (`PlatformDrainKickDO`) rather than the router's `waitUntil`. The drain re-lists and refills until the backlog is gone, and runs again while more remains. The scope's sweeper pass and a connection being connected or rotated each ask for a drain. Staff can re-drive a failed connector intent or a dead-lettered executor delivery with `POST /tenants/:t/scopes/:s/redrive`, audited as `redriveDelivery`.
