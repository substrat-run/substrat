---
'@substrat-run/connector-scrive': minor
---

The Scrive connector's `baseUrl` is now **required**, with no default.

It used to fall back to the testbed. That default is right for a developer and wrong for a
deployment: a production credential sent to the testbed comes back 401, indistinguishable from
a mistyped key — which is how production called the testbed for weeks. A deployment now names
its environment in the type system rather than in a comment, and `SCRIVE_TESTBED` /
`SCRIVE_PRODUCTION` are still exported to name it with.

A host that registers the connector only so it knows which events are connector deliveries —
a CP-less vertical, whose dispatching happens on the control plane — calls the new
`declareScriveConnector(host)` instead of `registerScriveConnector(host, {})`. With no default
left, "no provider base" is a statement about that host, not an omission.
