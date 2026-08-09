---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/control-plane": patch
---

feat: outbound connector dispatch rides platform-requests — a CP-less vertical's connector runs end to end (#574 phase 3, closes #574)

Phases 1 and 2 gave a hosted vertical the platform-run sweep and the
platform-terminated webhook ingress; outbound dispatch still ran nowhere — a
connector registered on a CP-less host would throw into dead-letters, because
the connection directory, the sealed credential, and sanctioned egress are all
platform-side. This closes the loop:

- **The vertical half** (`adapter-cloudflare`): on a CP-less host, `drainDue`
  routes each connector delivery onto the platform-requests surface instead of
  running the handler. A new ScopeDO verb enqueues the `connector:<provider>`
  intent (the kernel-stamped event embedded fat, `executorId` for attribution)
  and journals the delivery as routed in one atomic step, so a crash can never
  re-route or lose one; backpressure refuses before any write and the delivery
  retries on its own backoff. The inline drain reports routed deliveries
  through `onPlatformRequests`, so the response carries the router-kick header
  and dispatch latency collapses from sweep-cadence to seconds.
- **The platform half**: `ScopeHost` gains `dispatchConnector` (both adapters)
  — execute ONE routed delivery with this host's directory, credential, and
  egress, no journal (the intent row is the journal). `control-plane-api` adds
  `connectorDispatchHandler`, which parses the routed payload, refuses an event
  whose kernel stamps disagree with the drained scope (terminal), and runs the
  connector; a throw settles `pending` and retries under the attempt ceiling.
- **Contracts**: `connectorDispatchKind(provider)` / `connectorDispatchPayload`
  — the shared vocabulary between the routing host and the drain.
- **Kernel**: `ConnectorOptions.provider` (defaults to the registration id) and
  `ExecutorDrainReport.routedToPlatform`.
- **The control plane** registers `connector:scrive` in its drain-handler map,
  running the SAME `scriveConnector` closure a self-host registers — with the
  callback URL now minted as `PLATFORM_CP_URL` + `scriveCallbackPath(ref)`, so
  the capability URL terminates on the phase-2 ingress.
- **Meridian's CF worker** registers the connector (routing needs the
  registration; the handler never runs there) and flags
  `x-substrat-platform-request` on invokes that enqueued intents.

Self-host (node/SQLite) keeps its in-process wiring untouched; the connector
itself does not fork.
