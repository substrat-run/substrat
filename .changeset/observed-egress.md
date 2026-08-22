---
'@substrat-run/control-plane-api': minor
'@substrat-run/console': minor
---

A version's declared outbound surface can be checked against what it actually reached (#859, D-46).

D-46 declares a per-version outbound allowlist and enforces it at the dispatch egress seam.
What it never did was say whether the declaration is **true**. Two blind spots: a pre-#303
version resolves `hosts: null` and passes through unenforced, and DO-originated egress is not
intercepted at all — so a `fetch` made inside a scope DO was neither enforced nor recorded.

`GET /verticals/:slug/egress` closes the reporting half. It reads the `fetch` spans the
platform now emits (#858 proved they reach dispatch-namespace verticals, and that a
DO-originated fetch carries a resolvable `url.full`/`server.address`), aggregates them to
(service, host, origin), and joins each against the declared `outbound` of the version that
deployment ref belongs to. `matchesOutboundHost` does the comparison — the same function the
egress worker enforces with, so "allowed" cannot mean one thing here and another at the seam.

The console renders the difference **in the Outbound column of the versions table**, beside the
Admit button, because the admit decision is about the difference and a reader comparing two
columns by eye is how drift gets missed. An undeclared host shows its origin, and
`from a durable object — not enforced` is the whole point: that call was never refused because
nothing could see it.

**Three distinctions this refuses to collapse**, each of which would turn the report into a lie:

- **`unenforced` is not `undeclared`.** A pre-#303 version declares nothing and the egress
  worker lets it through by design. Rendering its hosts as violations would blame a vertical
  for the platform's own documented tail.
- **`unused` is not a fault.** A declared host not seen in the window is dimmed, never flagged —
  a quiet window is evidence of nothing.
- **`samplingRate: null` is not `1`.** One says every call was seen; the other says coverage is
  unknown. The coverage line under the table states the window, the sampling, and any
  truncation on every render rather than only when something looks wrong — an egress report
  that silently drops hosts is worse than none.

`observedEgress` is **optional** on `ObservabilityReader`: a backend can serve metrics and logs
and still have no span data, and absent must 501 rather than return an empty report, which would
read as "this vertical reached nothing".

**The dataset trap, recorded because it fails silently.** Spans are in `otel`, not
`cloudflare-workers`. Passing the wrong dataset returns an empty result with `success: true` —
never an error — so a wrong name is indistinguishable from a vertical that called nothing. A
`view: 'traces'` query with `datasets: ['cloudflare-workers']` returned 0 traces after reading
41M rows over seven days while 38 sat there. `querySpans` therefore omits `datasets` entirely,
which is the form actually verified on TEST, and filters on `spanName = 'fetch'` — never
`durable_object_subrequest`, which fires for the worker→DO hop and DO→DO stub calls, carries no
url or server, and so proves nothing about egress.

Enforcement is unchanged and still worker-context only: this reports, it does not refuse. Whether
we also want to *stop* DO-originated egress is #861, and is deliberately a separate decision.
