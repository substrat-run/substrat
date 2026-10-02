---
'@substrat-run/control-plane-client': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

The control-plane client is its own Apache-2.0 package, and the CLI talks to the plane through it (part of #971).

`@substrat-run/control-plane-client` holds the transport (credential selection, the problem-document reader, `ControlPlaneError`) and `ControlPlaneClient`, reaching nothing but `fetch` and `@substrat-run/contracts`. `@substrat-run/control-plane-api` re-exports it from both entries, so every existing import keeps working; the CLI depends on the client rather than on the AGPL server package. The transport gains an optional `headers` option, `ControlPlaneError` carries the raw `body`, `statusText` and response `headers` of a refusal (and the error `fetch` threw as its `cause`), a raw `request()` hands back the `Response`, and `fetch` is resolved at call time; `ControlPlaneBuilderClient` adds typed methods for the routes the CLI calls. Nothing a deployed caller sends or reads changes, and the CLI prints the same requests and the same messages as before.
