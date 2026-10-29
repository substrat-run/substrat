# @substrat-run/connector-planima

## 0.2.63

### Patch Changes

- Updated dependencies [9499b29]
  - @substrat-run/contracts@0.166.0
  - @substrat-run/kernel@0.166.0

## 0.2.62

### Patch Changes

- Updated dependencies [7df34ee]
  - @substrat-run/contracts@0.165.0
  - @substrat-run/kernel@0.165.0

## 0.2.61

### Patch Changes

- Updated dependencies [170078f]
- Updated dependencies [3225234]
- Updated dependencies [0e2bc1c]
- Updated dependencies [0b19237]
- Updated dependencies [2ade7ea]
- Updated dependencies [af79679]
- Updated dependencies [1e5a5af]
  - @substrat-run/contracts@0.164.0
  - @substrat-run/kernel@0.164.0

## 0.2.60

### Patch Changes

- Updated dependencies [ad35e20]
- Updated dependencies [60eb041]
- Updated dependencies [2eedfee]
  - @substrat-run/kernel@0.163.0
  - @substrat-run/contracts@0.163.0

## 0.2.59

### Patch Changes

- Updated dependencies [3310b4d]
- Updated dependencies [7d71f13]
  - @substrat-run/kernel@0.162.0
  - @substrat-run/contracts@0.162.0

## 0.2.58

### Patch Changes

- Updated dependencies [d52ad61]
- Updated dependencies [7d34c2c]
- Updated dependencies [1e7e16e]
- Updated dependencies [8bb7be5]
- Updated dependencies [2dfc19b]
- Updated dependencies [5279112]
- Updated dependencies [91a5ea1]
- Updated dependencies [81a07aa]
- Updated dependencies [14ce171]
  - @substrat-run/kernel@0.161.0
  - @substrat-run/contracts@0.161.0

## 0.2.57

### Patch Changes

- 9112dd6: A streamed connector response body now times out on idleness, not on total transfer time (#2518). A connection's `fetch` used to hold one `timeoutMs` deadline (default 30 s) over the whole exchange, so a streamed provider file had to arrive in full within it however fast its bytes were flowing, and a large file on a slow link could never land. Now `timeoutMs` bounds the call up to the response headers and any buffered read (`text()`, `json()`, `arrayBuffer()`), as before. Once the body is read as a stream (looking at `body`, or taking it and never reading, releases nothing) that deadline hands over to two limits: the stream errors when the provider sends no byte for `STREAM_IDLE_TIMEOUT_MS` (30 s; an empty chunk is not a byte, and a source that makes no progress, a thousand empty chunks in a row, errors the stream too), and 10 minutes after its first read (`STREAM_MAX_DURATION_MS`) however steadily it flows. A transfer that keeps flowing can outlast `timeoutMs`, but only if it finishes within `STREAM_MAX_DURATION_MS` (10 minutes); a stalled one (idle window or empty-read bound) or one still running at the cap errors with the same `TimeoutError`, the connection is released, and an upload reading it lands no object and no row.

  The kernel exports `deadlineFetch(fetch, timeoutMs, { idleMs, maxStreamMs })` and the two constants. Both hosts wrap the connection `fetch` in it, and take an optional `streamIdleTimeoutMs` so a test can use a short window. The Scrive, Fortnox, Planima and Microsoft 365 connectors use it for their own timed `fetch` in place of `AbortSignal.timeout`.

- Updated dependencies [8e8af88]
- Updated dependencies [f0b5904]
- Updated dependencies [763957c]
- Updated dependencies [361136b]
- Updated dependencies [581a697]
- Updated dependencies [dc3b911]
- Updated dependencies [a283098]
- Updated dependencies [95bdb79]
- Updated dependencies [26db572]
- Updated dependencies [5554dad]
- Updated dependencies [279f8e8]
- Updated dependencies [c304fbd]
- Updated dependencies [69868f3]
- Updated dependencies [5147141]
- Updated dependencies [a06e284]
- Updated dependencies [ee05879]
- Updated dependencies [9112dd6]
- Updated dependencies [78a0c96]
- Updated dependencies [09c081a]
- Updated dependencies [ecbed6e]
- Updated dependencies [d5f2f9a]
- Updated dependencies [bc36021]
- Updated dependencies [286f3b4]
- Updated dependencies [5f75359]
- Updated dependencies [bc629db]
  - @substrat-run/contracts@0.160.0
  - @substrat-run/kernel@0.160.0

## 0.2.56

### Patch Changes

- Updated dependencies [6aad0fb]
  - @substrat-run/contracts@0.159.0
  - @substrat-run/kernel@0.159.0

## 0.2.55

### Patch Changes

- @substrat-run/contracts@0.158.0
- @substrat-run/kernel@0.158.0

## 0.2.54

### Patch Changes

- Updated dependencies [d0af665]
- Updated dependencies [156febd]
  - @substrat-run/contracts@0.157.0
  - @substrat-run/kernel@0.157.0

## 0.2.53

### Patch Changes

- Updated dependencies [8bbf7e9]
- Updated dependencies [c5052f9]
- Updated dependencies [55a4dae]
- Updated dependencies [1344288]
  - @substrat-run/kernel@0.156.0
  - @substrat-run/contracts@0.156.0

## 0.2.52

### Patch Changes

- Updated dependencies [6933146]
- Updated dependencies [35bdba2]
- Updated dependencies [10b7e03]
  - @substrat-run/contracts@0.155.0
  - @substrat-run/kernel@0.155.0

## 0.2.51

### Patch Changes

- Updated dependencies [bf18880]
- Updated dependencies [34c4455]
- Updated dependencies [34c4455]
- Updated dependencies [1872bb7]
  - @substrat-run/contracts@0.154.0
  - @substrat-run/kernel@0.154.0

## 0.2.50

### Patch Changes

- Updated dependencies [1a064a0]
  - @substrat-run/kernel@0.153.0
  - @substrat-run/contracts@0.153.0

## 0.2.49

### Patch Changes

- Updated dependencies [482e9b7]
  - @substrat-run/contracts@0.152.0
  - @substrat-run/kernel@0.152.0

## 0.2.48

### Patch Changes

- Updated dependencies [8273013]
- Updated dependencies [4efc88d]
- Updated dependencies [a667881]
- Updated dependencies [f614b00]
- Updated dependencies [a00c87a]
  - @substrat-run/contracts@0.151.0
  - @substrat-run/kernel@0.151.0

## 0.2.47

### Patch Changes

- Updated dependencies [57700ea]
- Updated dependencies [52cc41f]
- Updated dependencies [9024575]
- Updated dependencies [5f77e74]
  - @substrat-run/kernel@0.150.0
  - @substrat-run/contracts@0.150.0

## 0.2.46

### Patch Changes

- Updated dependencies [98f09fe]
- Updated dependencies [0292dc0]
- Updated dependencies [b190e40]
- Updated dependencies [eda31d1]
- Updated dependencies [af096c6]
- Updated dependencies [39ccfea]
- Updated dependencies [6f5f12b]
- Updated dependencies [754fc62]
- Updated dependencies [c7eb5fa]
- Updated dependencies [1df1b93]
- Updated dependencies [6c1e359]
- Updated dependencies [439efc1]
- Updated dependencies [e550dec]
- Updated dependencies [4574ab8]
- Updated dependencies [3025154]
- Updated dependencies [9ae6644]
- Updated dependencies [d6ba289]
- Updated dependencies [2e503da]
- Updated dependencies [3608db6]
- Updated dependencies [9ceb545]
  - @substrat-run/kernel@0.149.0
  - @substrat-run/contracts@0.149.0

## 0.2.45

### Patch Changes

- Updated dependencies [ad3ca19]
- Updated dependencies [c4a0352]
- Updated dependencies [f855218]
- Updated dependencies [a8b0842]
- Updated dependencies [00253e0]
- Updated dependencies [a9cbb6d]
- Updated dependencies [7f8c6bf]
- Updated dependencies [d175d87]
- Updated dependencies [1bf5425]
  - @substrat-run/contracts@0.148.0
  - @substrat-run/kernel@0.148.0

## 0.2.44

### Patch Changes

- Updated dependencies [9926c53]
- Updated dependencies [8ff761c]
- Updated dependencies [cb957bc]
- Updated dependencies [cb957bc]
- Updated dependencies [4d14a81]
- Updated dependencies [5b1c20f]
- Updated dependencies [1ce756e]
- Updated dependencies [b854efd]
- Updated dependencies [23840a7]
- Updated dependencies [1ad1426]
- Updated dependencies [b4bb938]
- Updated dependencies [cb957bc]
  - @substrat-run/contracts@0.147.0
  - @substrat-run/kernel@0.147.0

## 0.2.43

### Patch Changes

- Updated dependencies [381f120]
- Updated dependencies [a55d75e]
- Updated dependencies [56b0af0]
  - @substrat-run/contracts@0.146.0
  - @substrat-run/kernel@0.146.0

## 0.2.42

### Patch Changes

- Updated dependencies [e786ff0]
- Updated dependencies [f49cc49]
- Updated dependencies [6aaf822]
- Updated dependencies [bb4f18d]
- Updated dependencies [2c75a0d]
- Updated dependencies [48e9503]
- Updated dependencies [5554b23]
- Updated dependencies [3782c4c]
- Updated dependencies [fac4f0a]
  - @substrat-run/contracts@0.145.0
  - @substrat-run/kernel@0.145.0

## 0.2.41

### Patch Changes

- Updated dependencies [835409e]
- Updated dependencies [f84eb3a]
- Updated dependencies [e286f87]
- Updated dependencies [f6d671b]
- Updated dependencies [134e6c2]
- Updated dependencies [6dc8097]
  - @substrat-run/contracts@0.144.0
  - @substrat-run/kernel@0.144.0

## 0.2.40

### Patch Changes

- Updated dependencies [e55e06c]
- Updated dependencies [7eb1b3c]
- Updated dependencies [7eb1b3c]
- Updated dependencies [e55e06c]
- Updated dependencies [dfb653b]
- Updated dependencies [f1c6c9a]
- Updated dependencies [6c44d57]
- Updated dependencies [9454e61]
  - @substrat-run/contracts@0.143.0
  - @substrat-run/kernel@0.143.0

## 0.2.39

### Patch Changes

- Updated dependencies [6a81de3]
- Updated dependencies [c78098a]
- Updated dependencies [65305a1]
- Updated dependencies [c56bb34]
  - @substrat-run/contracts@0.142.0
  - @substrat-run/kernel@0.142.0

## 0.2.38

### Patch Changes

- Updated dependencies [48be1e6]
- Updated dependencies [51bb25b]
- Updated dependencies [6a05977]
  - @substrat-run/contracts@0.141.0
  - @substrat-run/kernel@0.141.0

## 0.2.37

### Patch Changes

- Updated dependencies [35dc72e]
- Updated dependencies [32df62b]
- Updated dependencies [6154fd9]
- Updated dependencies [6d49012]
- Updated dependencies [55e6241]
- Updated dependencies [13a2067]
- Updated dependencies [7b15101]
- Updated dependencies [72f8e92]
- Updated dependencies [100b47c]
- Updated dependencies [d42bb2b]
- Updated dependencies [e5bd928]
- Updated dependencies [b180d3e]
- Updated dependencies [07388df]
- Updated dependencies [ae80b0d]
- Updated dependencies [a1f40e5]
- Updated dependencies [0e3d406]
- Updated dependencies [fed1f3c]
- Updated dependencies [5405401]
- Updated dependencies [655141a]
- Updated dependencies [f1290ea]
- Updated dependencies [ced5130]
  - @substrat-run/kernel@0.140.0
  - @substrat-run/contracts@0.140.0

## 0.2.36

### Patch Changes

- Updated dependencies [d62f6fb]
- Updated dependencies [98492af]
- Updated dependencies [2a505df]
- Updated dependencies [ec25a00]
- Updated dependencies [4a14c92]
- Updated dependencies [d55b4cd]
- Updated dependencies [48bf765]
  - @substrat-run/kernel@0.139.0
  - @substrat-run/contracts@0.139.0

## 0.2.35

### Patch Changes

- Updated dependencies [d5739ca]
- Updated dependencies [50ce5e0]
- Updated dependencies [59972cb]
- Updated dependencies [6476e71]
- Updated dependencies [d08b9b1]
- Updated dependencies [f33b1c3]
- Updated dependencies [bc6cc57]
- Updated dependencies [921dfa3]
  - @substrat-run/kernel@0.138.0
  - @substrat-run/contracts@0.138.0

## 0.2.34

### Patch Changes

- Updated dependencies [7559e1a]
- Updated dependencies [21055d5]
- Updated dependencies [b641075]
- Updated dependencies [7adf5c7]
- Updated dependencies [1c411fc]
- Updated dependencies [fcb587d]
  - @substrat-run/contracts@0.137.0
  - @substrat-run/kernel@0.137.0

## 0.2.33

### Patch Changes

- Updated dependencies [1af2d47]
- Updated dependencies [fb1f624]
- Updated dependencies [4fdad69]
- Updated dependencies [4964eb8]
- Updated dependencies [30c2cda]
- Updated dependencies [b9b3b82]
- Updated dependencies [3ed9e9d]
- Updated dependencies [cdf32ab]
- Updated dependencies [7a28aea]
- Updated dependencies [7418e7e]
- Updated dependencies [18069f9]
  - @substrat-run/kernel@0.136.0
  - @substrat-run/contracts@0.136.0

## 0.2.32

### Patch Changes

- Updated dependencies [8267b83]
- Updated dependencies [1dca2da]
- Updated dependencies [3328549]
- Updated dependencies [8c64633]
- Updated dependencies [5d41454]
  - @substrat-run/kernel@0.135.0
  - @substrat-run/contracts@0.135.0

## 0.2.31

### Patch Changes

- Updated dependencies [176fe60]
- Updated dependencies [4347933]
- Updated dependencies [4347933]
- Updated dependencies [1addd27]
- Updated dependencies [560eec4]
  - @substrat-run/kernel@0.134.0
  - @substrat-run/contracts@0.134.0

## 0.2.30

### Patch Changes

- Updated dependencies [8a32578]
- Updated dependencies [c74c091]
- Updated dependencies [a08c42e]
- Updated dependencies [a128e65]
  - @substrat-run/kernel@0.133.0
  - @substrat-run/contracts@0.133.0

## 0.2.29

### Patch Changes

- @substrat-run/contracts@0.132.0
- @substrat-run/kernel@0.132.0

## 0.2.28

### Patch Changes

- Updated dependencies [012b2c8]
- Updated dependencies [56091f8]
- Updated dependencies [e5c21fc]
  - @substrat-run/contracts@0.131.0
  - @substrat-run/kernel@0.131.0

## 0.2.27

### Patch Changes

- Updated dependencies [65a0690]
- Updated dependencies [b53ecff]
- Updated dependencies [8236531]
  - @substrat-run/kernel@0.130.0
  - @substrat-run/contracts@0.130.0

## 0.2.26

### Patch Changes

- Updated dependencies [b213bfc]
  - @substrat-run/contracts@0.129.0
  - @substrat-run/kernel@0.129.0

## 0.2.25

### Patch Changes

- Updated dependencies [260fb5a]
- Updated dependencies [4a53af7]
- Updated dependencies [4ba2a52]
- Updated dependencies [f79e8ba]
- Updated dependencies [ba75c81]
  - @substrat-run/contracts@0.128.0
  - @substrat-run/kernel@0.128.0

## 0.2.24

### Patch Changes

- Updated dependencies [2f1e5f5]
- Updated dependencies [b6248b0]
  - @substrat-run/kernel@0.127.0
  - @substrat-run/contracts@0.127.0

## 0.2.23

### Patch Changes

- Updated dependencies [6d57761]
- Updated dependencies [c78e713]
- Updated dependencies [e1526a0]
  - @substrat-run/contracts@0.126.0
  - @substrat-run/kernel@0.126.0

## 0.2.22

### Patch Changes

- Updated dependencies [e8d4860]
- Updated dependencies [9ebacee]
  - @substrat-run/contracts@0.125.0
  - @substrat-run/kernel@0.125.0

## 0.2.21

### Patch Changes

- Updated dependencies [90d0f02]
- Updated dependencies [02942e0]
- Updated dependencies [931b8d6]
- Updated dependencies [558f103]
- Updated dependencies [45421e8]
  - @substrat-run/kernel@0.124.0
  - @substrat-run/contracts@0.124.0

## 0.2.20

### Patch Changes

- Updated dependencies [f56e9eb]
- Updated dependencies [6b3cb45]
- Updated dependencies [ae19d01]
- Updated dependencies [30b09c6]
- Updated dependencies [d423d10]
- Updated dependencies [bd8f408]
  - @substrat-run/contracts@0.123.0
  - @substrat-run/kernel@0.123.0

## 0.2.19

### Patch Changes

- Updated dependencies [0803833]
- Updated dependencies [1e326dd]
- Updated dependencies [3a3338d]
  - @substrat-run/contracts@0.122.0
  - @substrat-run/kernel@0.122.0

## 0.2.18

### Patch Changes

- a3216e6: Document why no connector records `Connection.expiresAt`: Scrive (OAuth1 personal access credentials), Fortnox (`client_credentials`, 1h access tokens) and Planima (a static token) have no refresh credential with a horizon, so "not reported" is the true answer. Comments and tests only; no behaviour change.
- Updated dependencies [a235648]
- Updated dependencies [6fc9950]
- Updated dependencies [48fea30]
- Updated dependencies [a6f4db1]
- Updated dependencies [45b927e]
  - @substrat-run/contracts@0.121.0
  - @substrat-run/kernel@0.121.0

## 0.2.17

### Patch Changes

- Updated dependencies [1de077d]
  - @substrat-run/kernel@0.120.0
  - @substrat-run/contracts@0.120.0

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
