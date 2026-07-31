---
'@substrat-run/kernel': minor
'@substrat-run/control-plane': patch
---

Platform intents, Phase C (periodic trigger): drain intents on the platform sweep.

`runPlatformSweep` gains an injected `drainPlatformRequestsFn` option (mirroring `reapScopeFn`):
when supplied, a new phase enumerates active scopes and drains each one's pending platform intents,
summing per-scope counts into a new `platformRequestTotals` report field (and recording per-scope
failures under a new `'platform-request'` error kind — one failure never sinks the pass). Unset ⇒
the phase is skipped. It is injected because the kernel can't reach a vertical's scope DO (it lives
in the vertical's own deployment); the control plane supplies the fn.

The control-plane worker's scheduled sweep now wires it: for each active scope it resolves the
serving `VerticalClient` (the same serving-script → bound-version → prod ladder the API uses) and
runs Phase B2's `drainScopePlatformRequests` with the `provision-sibling` handler. So a Manyfold
site request enqueued via `ctx.requestPlatform` is picked up and provisioned within a sweep cycle.

This is the PERIODIC trigger (~2-min cadence, the reliability backstop). The low-latency router
kick and the vertical's `/internal/platform-requests` endpoints (which expose the drain to the
platform) land in Phase D alongside the Manyfold end-to-end. Refs #358.
