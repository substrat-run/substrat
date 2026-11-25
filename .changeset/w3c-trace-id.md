---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/vertical-host": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/router": patch
"@substrat-run/vertical-egress": patch
---

A W3C trace id now follows a request across every app it touches. The router continues the incoming `traceparent` when it is well formed, and starts a new trace when there is none or it is malformed. It puts the trace on the request it dispatches and names its id as `traceId` on its own request line. The trace goes on to every call the platform makes for that request: peer calls, store calls and connector calls. Each hop continues it under a new span. The invocation line has an optional `traceId`, so one request can be followed across apps, and a `ctx.log` line joins it through its `invocationId`. A trace id is a correlation id only and grants nothing. A caller's `tracestate` reaches the routed app only beside the trace it belongs to. No platform hop after that carries one, and a call to a third party gets no trace header from the platform. Contracts adds `TRACEPARENT_HEADER`, `TRACESTATE_HEADER`, `parseTraceparent`, `traceIdOf` and `nextTraceparent`. The kernel adds `currentTraceparent`.
