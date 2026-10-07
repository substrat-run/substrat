---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
---

Connectors can now finish their own credential on the platform side, and serve a public certificate (#2100).

`@substrat-run/control-plane-api`: a `ConnectionInspector` may declare `prepareCandidate(candidate, previous)`. The connection upsert runs it before the connect-time probe, so the probe checks exactly what gets stored, and on a rotation it receives the live connection's secret. A provider can therefore generate part of a credential where it is sealed (the Microsoft 365 connector generates a per-connection keypair there) and keep it when someone edits the other fields. An expiry it returns lands on the connection unless the caller named one. The upsert now looks up the live connection before probing rather than after, with no change in behaviour for providers that declare no preparation. A new `GET /tenants/:t/connections/:id/certificate` route serves the public certificate a connection signs in with, through the inspector's new `certificate`, and answers 404 when the connection has none.

`@substrat-run/contracts`: `connectionCertificate` gives that route's shape: `pem`, the `thumbprint` as the provider's own console shows it, and `notAfter`.
