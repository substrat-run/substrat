---
"@substrat-run/contracts": minor
---

A request trace has a shape. `requestTrace` is the head of the hosted invocation line (#1746, same field names) plus the steps inside the call: permission checks, SQL, emitted events, log lines, validation errors, outbound and store calls, and the error that ended it. A hosted record can fill the head alone; `capture` says what a recorder kept. `TraceSink` and `TRACE_SINK_KEY` are the seam a host records through: a host reads one slot on `globalThis` and does nothing when it is empty. Both are also on the new zero-import subpath `@substrat-run/contracts/trace-sink`, which a bundle without zod can use. Nothing records a trace yet.
