---
'@substrat-run/kernel': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/dashboard': patch
'@substrat-run/dashboard-web': patch
'@substrat-run/vertical-egress': patch
---

An invocation line names the outbound `fetch` calls a request made: the host, the path, the method, the status, how long the response took, when in the request the call started, and how it ended (`ok`, `http-error`, `refused`, `timeout`, `aborted`, `failed`). The vertical passes nothing. The platform entry puts a recorder in front of `fetch` on the first request and records each call made while a request is running. Outside a request the call goes straight to the runtime. Inside one, the arguments, the body stream and the signal are passed on untouched, and the runtime's own response or error comes back. A fault in the recorder never fails the call.

A call the platform's egress policy refused is recorded as `refused`, read from `x-substrat-egress: refused`, so it no longer reads like the destination's own 403. Headers, bodies, query strings, fragments and userinfo are never recorded. The path is redacted by default: a segment is kept only when it is lowercase words (each part at most 16 letters, joined by `-` or `_`, optionally with a short file extension), an integer of at most 10 digits, or a version token such as `v1`. Every other segment, every UUID and ULID among them, is written `[redacted]`. The host is always written. A failed call names its error's class, never its message. The first 16 calls are named and the rest counted in `outboundCallsDropped`. Calls made inside a Durable Object, after the response, or through a `fetch` reference saved while the bundle loaded are not recorded. The egress worker strips `x-substrat-egress` from every answer it passes through, and a call is `refused` only on a 403 carrying exactly `refused`, so a destination cannot make its own answer read as the platform's.

The control plane's request record carries `outboundCalls` and `outboundCallsDropped`, read by `outboundCallsOf`, which the browser entry exports too. The dashboard's request panel lists the calls and draws each one on the timeline.
