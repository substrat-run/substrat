---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/connector-scrive': patch
'@substrat-run/connector-fortnox': patch
'@substrat-run/connector-planima': patch
---

Every connector call now becomes one data point, so connection health has a trend and not only a last line.

`@substrat-run/kernel` adds `connector-calls.ts`: the `ConnectorCallRecorder` interface, a no-op default, and `analyticsEngineConnectorCallRecorder`, which writes one Analytics Engine point per call and counts the writes it drops. The record is keyed by OpenTelemetry semantic-convention names: `substrat.tenant.id`, `substrat.vertical` (the slug), `substrat.connection.provider`, `error.type`, `http.response.status_code` and `http.client.request.duration` (in seconds). `error.type` is absent on success and otherwise one of a closed enum (`4xx`, `5xx`, `other_status`, `timeout`, `network`, `_OTHER`), so no field can carry a credential, URL, body or error message. `CONNECTOR_CALL_DATA_POINT_LAYOUT` publishes which Analytics Engine position holds each name, and only grows. `recordConnectionUse` also accepts optional `durationMs`, `status` and `timedOut`, and `settleConnectionUse` builds that settlement from a response or a thrown error.

`@substrat-run/adapter-sqlite` and `@substrat-run/adapter-cloudflare` take an optional `connectorCalls` recorder, which defaults to the no-op. Each host records a call where it settles the health line, using the identity on the connection row. The call to the recorder is fire-and-forget: it is never awaited, and a throw is swallowed. The connection's `fetch` now times each call.

`@substrat-run/control-plane-api` adds `GET /connections/calls?hours=&provider=`, a staff and service read of calls and errors per provider, bucketed and sampling-weighted, for up to seven days. Tenant and builder credentials are refused, and the route answers 501 until `createCfObservabilityReader` is given a `connectorCallsDataset`.

The Scrive, Fortnox and Planima connectors time the calls they make on their own connections, so those calls carry a duration too.
