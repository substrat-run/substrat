---
"@substrat-run/contracts": minor
---

A trace sink can say what it wants beyond the default: `TraceSink.capture.sqlParams` asks a host to send the values bound to each statement, and a host sends none unless it is asked. Every recorder stamps a step on one time axis: the layer that starts the request calls `markTraceStart`, and `traceOffsetMs` counts from that mark, so a step recorded by the scope host and one recorded by the HTTP layer agree on zero. An outbound step can carry the failure class (`reason`), and a head patch can carry `stepsDropped`, so a truncated list reads as truncated. A refusal on an entity check also names the entity grant that would have allowed it.
