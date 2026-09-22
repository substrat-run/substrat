# @substrat-run/connector-planima

## 0.2.16

### Patch Changes

- 84b5fe2: Every connector call now becomes one data point, so connection health has a trend and not only a last line.

  `@substrat-run/kernel` adds `connector-calls.ts`: the `ConnectorCallRecorder` interface, a no-op default, and `analyticsEngineConnectorCallRecorder`, which writes one Analytics Engine point per call and counts the writes it drops. The record is keyed by OpenTelemetry semantic-convention names: `substrat.tenant.id`, `substrat.vertical` (the slug), `substrat.connection.provider`, `error.type`, `http.response.status_code` and `http.client.request.duration` (in seconds). `error.type` is absent on success and otherwise one of a closed enum (`4xx`, `5xx`, `other_status`, `timeout`, `network`, `_OTHER`), so no field can carry a credential, URL, body or error message. `CONNECTOR_CALL_DATA_POINT_LAYOUT` publishes which Analytics Engine position holds each name, and only grows. `recordConnectionUse` also accepts optional `durationMs`, `status` and `timedOut`, and `settleConnectionUse` builds that settlement from a response or a thrown error.

  `@substrat-run/adapter-sqlite` and `@substrat-run/adapter-cloudflare` take an optional `connectorCalls` recorder, which defaults to the no-op. Each host records a call where it settles the health line, using the identity on the connection row. The call to the recorder is fire-and-forget: it is never awaited, and a throw is swallowed. The connection's `fetch` now times each call.

  `@substrat-run/control-plane-api` adds `GET /connections/calls?hours=&provider=`, a staff and service read of calls and errors per provider, bucketed and sampling-weighted, for up to seven days. Tenant and builder credentials are refused, and the route answers 501 until `createCfObservabilityReader` is given a `connectorCallsDataset`.

  The Scrive, Fortnox and Planima connectors time the calls they make on their own connections, so those calls carry a duration too.

- Updated dependencies [bc6a6bb]
- Updated dependencies [bb10d6d]
- Updated dependencies [84b5fe2]
- Updated dependencies [929ec09]
- Updated dependencies [a9cfc4a]
- Updated dependencies [2c65b67]
- Updated dependencies [8009cd1]
- Updated dependencies [b080e0f]
- Updated dependencies [e7113ea]
  - @substrat-run/kernel@0.119.0
  - @substrat-run/contracts@0.119.0

## 0.2.15

### Patch Changes

- Updated dependencies [030fafd]
- Updated dependencies [56a931b]
- Updated dependencies [429cc84]
  - @substrat-run/contracts@0.118.0
  - @substrat-run/kernel@0.118.0

## 0.2.14

### Patch Changes

- Updated dependencies [6504a99]
- Updated dependencies [aabc227]
- Updated dependencies [fb37a3e]
- Updated dependencies [44299a1]
- Updated dependencies [4ef164c]
- Updated dependencies [d7eb089]
- Updated dependencies [269fa7a]
- Updated dependencies [105a4c3]
- Updated dependencies [a8c2c64]
- Updated dependencies [02c181a]
- Updated dependencies [2fa5147]
- Updated dependencies [1f223f5]
  - @substrat-run/contracts@0.117.0
  - @substrat-run/kernel@0.117.0

## 0.2.13

### Patch Changes

- Updated dependencies [e22db55]
- Updated dependencies [a67c59b]
- Updated dependencies [45d2f15]
- Updated dependencies [e99332e]
- Updated dependencies [1c55458]
- Updated dependencies [0b993ff]
  - @substrat-run/contracts@0.116.0
  - @substrat-run/kernel@0.116.0

## 0.2.12

### Patch Changes

- Updated dependencies [1a6fe4d]
  - @substrat-run/contracts@0.115.0
  - @substrat-run/kernel@0.115.0

## 0.2.11

### Patch Changes

- Updated dependencies [f58aa74]
  - @substrat-run/contracts@0.114.0
  - @substrat-run/kernel@0.114.0

## 0.2.10

### Patch Changes

- Updated dependencies [c146761]
- Updated dependencies [c3c92e9]
- Updated dependencies [2fc7187]
- Updated dependencies [7e6f925]
  - @substrat-run/contracts@0.113.0
  - @substrat-run/kernel@0.113.0

## 0.2.9

### Patch Changes

- Updated dependencies [c697b15]
- Updated dependencies [db6a96f]
- Updated dependencies [221f94a]
- Updated dependencies [f4d12b7]
  - @substrat-run/contracts@0.112.0
  - @substrat-run/kernel@0.112.0

## 0.2.8

### Patch Changes

- Updated dependencies [f08bfc4]
- Updated dependencies [aaafae3]
- Updated dependencies [1b2506c]
  - @substrat-run/contracts@0.111.0
  - @substrat-run/kernel@0.111.0

## 0.2.7

### Patch Changes

- Updated dependencies [a195037]
- Updated dependencies [8758949]
- Updated dependencies [d05689d]
- Updated dependencies [0257dbd]
- Updated dependencies [cb88aa1]
  - @substrat-run/contracts@0.110.0
  - @substrat-run/kernel@0.110.0

## 0.2.6

### Patch Changes

- Updated dependencies [7aa3ea5]
- Updated dependencies [1e175ce]
- Updated dependencies [4fc7db2]
- Updated dependencies [62f4e87]
  - @substrat-run/contracts@0.109.0
  - @substrat-run/kernel@0.109.0

## 0.2.5

### Patch Changes

- Updated dependencies [5e80e5f]
- Updated dependencies [5cf7ae4]
- Updated dependencies [44b53e4]
  - @substrat-run/kernel@0.108.0
  - @substrat-run/contracts@0.108.0

## 0.2.4

### Patch Changes

- Updated dependencies [bf9490a]
- Updated dependencies [4a6c4c3]
  - @substrat-run/kernel@0.107.0
  - @substrat-run/contracts@0.107.0

## 0.2.3

### Patch Changes

- Updated dependencies [2956182]
  - @substrat-run/kernel@0.106.0
  - @substrat-run/contracts@0.106.0

## 0.2.2

### Patch Changes

- Updated dependencies [5201683]
  - @substrat-run/kernel@0.105.0
  - @substrat-run/contracts@0.105.0

## 0.2.1

### Patch Changes

- Updated dependencies [dd999a9]
  - @substrat-run/contracts@0.104.0
  - @substrat-run/kernel@0.104.0

## 0.2.0

### Minor Changes

- dcde11e: Add `@substrat-run/connector-planima` — the inbound half of Planima (Swedish planned
  facility maintenance) integration.

  Poll-only and read-only, in `connector-fortnox`'s shape: a connection is bound to a scope
  with `bindPlanimaScope` (which refuses a binding whose grant is missing), and
  `sweepPlanimaPlan` reads each bound scope's maintenance plan — facilities, buildings,
  components, and the costed actions in a year window — hashes it, and lands it through the
  consuming vertical's own operation as the connection itself. An unchanged plan lands
  nothing.

  The client throttles itself to Planima's 10-requests-per-10-seconds limit and obeys the
  `Retry-After` a 429 carries. Prices arrive as JSON floats and cross the seam as exact
  decimal money in a currency the binding declares, because Planima's API states none.

  A plan that has become empty lands one explicit CLEAR page (`facility: null`,
  `final: true`) rather than nothing, so a consumer that swaps on `final` cannot be left
  holding the previous sync's rows for ever. A 200 whose body carries no `data` array is
  refused as a response fault rather than read as an empty list. One rate-limit window is
  shared across every binding in a sweep, because Planima meters per token rather than per
  client.

  `ConnectorResponse` gains an optional `headers` — some provider instructions (`Retry-After`
  here) live only in a response header, and reading one had no sanctioned route through the
  connector seam.

### Patch Changes

- Updated dependencies [dc9995c]
- Updated dependencies [dcde11e]
- Updated dependencies [adf6bfb]
  - @substrat-run/contracts@0.103.0
  - @substrat-run/kernel@0.103.0
