---
'@substrat-run/kernel': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/dashboard': patch
'@substrat-run/dashboard-web': patch
---

An invocation line names the outbound `fetch` calls a request made: the host, the path, the method, the status, how long the response took, when in the request the call started, and how it ended (`ok`, `http-error`, `refused`, `timeout`, `aborted`, `failed`). The vertical passes nothing. The platform entry puts a recorder in front of `fetch` on the first request and records each call made while a request is running. Outside a request the call goes straight to the runtime. Inside one, the arguments, the body stream and the signal are passed on untouched, and the runtime's own response or error comes back. A fault in the recorder never fails the call.

A call the platform's egress policy refused is recorded as `refused`, read from `x-substrat-egress: refused`, so it no longer reads like the destination's own 403. Headers, bodies, query strings, fragments and userinfo are never recorded. A path segment that could be a credential is written `[redacted]`: anything of 20 characters or more that is not a UUID or a ULID, anything holding `:` `=` `%` `@`, and any run of 16 letters and digits. A failed call names its error's class, never its message. The first 16 calls are named and the rest counted in `outboundCallsDropped`. Calls made inside a Durable Object or after the response are not recorded.

The control plane's request record carries `outboundCalls` and `outboundCallsDropped`, read by `outboundCallsOf`, which the browser entry exports too. The dashboard's request panel lists the calls and draws each one on the timeline.
