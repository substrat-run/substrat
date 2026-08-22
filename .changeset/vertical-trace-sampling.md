---
'@substrat-run/control-plane-api': minor
---

Pushed verticals can declare Workers automatic tracing, off unless the platform sets a rate (#858).

Every `substrat push` has uploaded its script with `observability: { enabled: true }`, and that
has been buying **logs only**. Cloudflare is explicit: *"While automatic tracing is in early beta,
this setting will not enable tracing by default, and will only enable logs."* Spans need their own
`traces` block, which nothing sent.

`WfpUploaderOptions.traceSampling` adds it. Absent — every caller today — omits the block entirely,
so deploying this changes nothing about what any script emits. The control plane reads it from
`VERTICAL_TRACE_SAMPLING`, and only the **test** environment sets one (`"1"`); prod sets nothing.

**A rate, not a boolean.** Tracing instruments every I/O operation, each span is one observability
event sharing quota with Workers Logs, and beta pricing ends 2026-10-01 — so the fleet question was
never on-or-off but how-much, and a dial lets TEST run at 1 while prod stays dark. `undefined` and
`0` are deliberately different: undefined never declared tracing, `0` declared it and samples none.
An unparseable or out-of-range value is ignored rather than clamped, because #858 concludes from an
*absence* of spans and a silently-clamped typo would make that absence unfalsifiable.

**What this is for.** D-46 documents that Cloudflare outbound workers do not intercept
Durable-Object-originated subrequests, and verticals are DO-centric — so that egress is beyond the
egress worker. Automatic tracing is instrumented inside workerd and emits a `durable_object_subrequest`
span, which would make those calls visible even though they stay unenforceable. Whether any of it
reaches a **dispatch-namespace user worker**, and whose account the spans land in, is undocumented
either way; that is the question TEST is being asked, not an assumption this change bakes in.
