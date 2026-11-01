# @substrat-run/vertical-egress

## 0.2.38

### Patch Changes

- Updated dependencies [b8b837b]
  - @substrat-run/contracts@0.174.0

## 0.2.37

### Patch Changes

- @substrat-run/contracts@0.173.0

## 0.2.36

### Patch Changes

- Updated dependencies [e8e51ba]
- Updated dependencies [279c6f3]
- Updated dependencies [06c306f]
  - @substrat-run/contracts@0.172.0

## 0.2.35

### Patch Changes

- Updated dependencies [2c7b3a7]
- Updated dependencies [e3f11a8]
  - @substrat-run/contracts@0.171.0

## 0.2.34

### Patch Changes

- Updated dependencies [f0e000d]
- Updated dependencies [0bc0f4a]
  - @substrat-run/contracts@0.170.0

## 0.2.33

### Patch Changes

- Updated dependencies [9e6412c]
- Updated dependencies [77d504f]
- Updated dependencies [fb2de85]
  - @substrat-run/contracts@0.169.0

## 0.2.32

### Patch Changes

- Updated dependencies [e34da92]
  - @substrat-run/contracts@0.168.0

## 0.2.31

### Patch Changes

- Updated dependencies [280f175]
  - @substrat-run/contracts@0.167.0

## 0.2.30

### Patch Changes

- Updated dependencies [9499b29]
  - @substrat-run/contracts@0.166.0

## 0.2.29

### Patch Changes

- Updated dependencies [7df34ee]
  - @substrat-run/contracts@0.165.0

## 0.2.28

### Patch Changes

- Updated dependencies [170078f]
- Updated dependencies [3225234]
- Updated dependencies [0b19237]
- Updated dependencies [1e5a5af]
  - @substrat-run/contracts@0.164.0

## 0.2.27

### Patch Changes

- Updated dependencies [2eedfee]
  - @substrat-run/contracts@0.163.0

## 0.2.26

### Patch Changes

- Updated dependencies [7d71f13]
  - @substrat-run/contracts@0.162.0

## 0.2.25

### Patch Changes

- Updated dependencies [7d34c2c]
- Updated dependencies [8bb7be5]
- Updated dependencies [81a07aa]
- Updated dependencies [14ce171]
  - @substrat-run/contracts@0.161.0

## 0.2.24

### Patch Changes

- Updated dependencies [8e8af88]
- Updated dependencies [f0b5904]
- Updated dependencies [763957c]
- Updated dependencies [361136b]
- Updated dependencies [dc3b911]
- Updated dependencies [a283098]
- Updated dependencies [95bdb79]
- Updated dependencies [69868f3]
- Updated dependencies [ee05879]
- Updated dependencies [78a0c96]
- Updated dependencies [09c081a]
- Updated dependencies [ecbed6e]
- Updated dependencies [bc36021]
- Updated dependencies [286f3b4]
- Updated dependencies [5f75359]
- Updated dependencies [bc629db]
  - @substrat-run/contracts@0.160.0

## 0.2.23

### Patch Changes

- Updated dependencies [6aad0fb]
  - @substrat-run/contracts@0.159.0

## 0.2.22

### Patch Changes

- @substrat-run/contracts@0.158.0

## 0.2.21

### Patch Changes

- Updated dependencies [d0af665]
- Updated dependencies [156febd]
  - @substrat-run/contracts@0.157.0

## 0.2.20

### Patch Changes

- Updated dependencies [c5052f9]
- Updated dependencies [1344288]
  - @substrat-run/contracts@0.156.0

## 0.2.19

### Patch Changes

- Updated dependencies [6933146]
- Updated dependencies [35bdba2]
  - @substrat-run/contracts@0.155.0

## 0.2.18

### Patch Changes

- Updated dependencies [bf18880]
- Updated dependencies [34c4455]
- Updated dependencies [1872bb7]
  - @substrat-run/contracts@0.154.0

## 0.2.17

### Patch Changes

- @substrat-run/contracts@0.153.0

## 0.2.16

### Patch Changes

- Updated dependencies [482e9b7]
  - @substrat-run/contracts@0.152.0

## 0.2.15

### Patch Changes

- Updated dependencies [8273013]
- Updated dependencies [4efc88d]
- Updated dependencies [a667881]
- Updated dependencies [f614b00]
  - @substrat-run/contracts@0.151.0

## 0.2.14

### Patch Changes

- Updated dependencies [52cc41f]
- Updated dependencies [9024575]
- Updated dependencies [5f77e74]
  - @substrat-run/contracts@0.150.0

## 0.2.13

### Patch Changes

- 6f5f12b: A request started by another one through a peer call can now be related to it. The invocation line has an optional `parentInvocationId`, written only when there is one, so every other line is unchanged. A peer call carries the calling request's id on the `x-substrat-parent-request-id` header, from `peerClient` through the egress worker and the router to the target's `/internal/vertical-invoke`. The target now runs the operation under its own request id, so its events are stamped, and writes one invocation line per peer call, naming the caller as the parent (`parentInvocationId`) and the caller's scope, which the router names in the platform-verified body (`parentScopeId`). The tenant on that line is the one in that body. The parent id is the caller's own claim: each hop passes it on only as a single ULID and drops anything else, and it is used only to relate two requests. The dashboard's request panel lists the caller as "Caused by … peer call" and opens it in the calling app when the team holds that app. Otherwise it shows the id without a link. The read stays bound to the team's own tenant.

  A purge schedule's run now runs every purge in its pass under the run's own invocation id, on both adapters, so the purges' events and deliveries join the run's line. Before, each purge minted an id that no line named.

  The dashboard's create, retry and resume failure toasts now name the request id when the answer carried one.

- e550dec: An invocation line names the outbound `fetch` calls a request made: the host, the path, the method, the status, how long the response took, when in the request the call started, and how it ended (`ok`, `http-error`, `refused`, `timeout`, `aborted`, `failed`). The vertical passes nothing. The platform entry puts a recorder in front of `fetch` on the first request and records each call made while a request is running. Outside a request the call goes straight to the runtime. Inside one, the arguments, the body stream and the signal are passed on untouched, and the runtime's own response or error comes back. A fault in the recorder never fails the call.

  A call the platform's egress policy refused is recorded as `refused`, read from `x-substrat-egress: refused`, so it no longer reads like the destination's own 403. Headers, bodies, query strings, fragments and userinfo are never recorded. The path is redacted by default: a segment of at most 40 characters is kept only when it is lowercase words (at most 4 parts, each at most 16 letters, joined by `-` or `_`, optionally with a short file extension), an integer of at most 10 digits, or a version token such as `v1`. Every other segment, every UUID and ULID among them, is written `[redacted]`. The host is always written. A failed call names its error's class, never its message. The first 16 calls are named and the rest counted in `outboundCallsDropped`. Calls made inside a Durable Object, after the response, or through a `fetch` reference saved while the bundle loaded are not recorded. The egress worker strips `x-substrat-egress` from every answer it passes through, and a call is `refused` only on a 403 carrying exactly `refused`, so a destination cannot make its own answer read as the platform's.

  The control plane's request record carries `outboundCalls` and `outboundCallsDropped`, read by `outboundCallsOf`, which the browser entry exports too. The dashboard's request panel lists the calls and draws each one on the timeline.

- Updated dependencies [0292dc0]
- Updated dependencies [b190e40]
- Updated dependencies [eda31d1]
- Updated dependencies [af096c6]
- Updated dependencies [39ccfea]
- Updated dependencies [6f5f12b]
- Updated dependencies [c7eb5fa]
- Updated dependencies [1df1b93]
- Updated dependencies [439efc1]
- Updated dependencies [3025154]
- Updated dependencies [9ae6644]
- Updated dependencies [d6ba289]
- Updated dependencies [2e503da]
- Updated dependencies [3608db6]
- Updated dependencies [9ceb545]
  - @substrat-run/contracts@0.149.0

## 0.2.12

### Patch Changes

- Updated dependencies [ad3ca19]
- Updated dependencies [c4a0352]
- Updated dependencies [f855218]
- Updated dependencies [a8b0842]
- Updated dependencies [00253e0]
- Updated dependencies [a9cbb6d]
- Updated dependencies [1bf5425]
  - @substrat-run/contracts@0.148.0

## 0.2.11

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
  - @substrat-run/contracts@0.147.0

## 0.2.10

### Patch Changes

- Updated dependencies [381f120]
- Updated dependencies [a55d75e]
- Updated dependencies [56b0af0]
  - @substrat-run/contracts@0.146.0

## 0.2.9

### Patch Changes

- Updated dependencies [e786ff0]
- Updated dependencies [f49cc49]
- Updated dependencies [6aaf822]
- Updated dependencies [2c75a0d]
- Updated dependencies [48e9503]
- Updated dependencies [5554b23]
- Updated dependencies [3782c4c]
- Updated dependencies [fac4f0a]
  - @substrat-run/contracts@0.145.0

## 0.2.8

### Patch Changes

- Updated dependencies [835409e]
- Updated dependencies [f84eb3a]
- Updated dependencies [e286f87]
- Updated dependencies [f6d671b]
  - @substrat-run/contracts@0.144.0

## 0.2.7

### Patch Changes

- Updated dependencies [e55e06c]
- Updated dependencies [7eb1b3c]
- Updated dependencies [dfb653b]
- Updated dependencies [6c44d57]
- Updated dependencies [9454e61]
  - @substrat-run/contracts@0.143.0

## 0.2.6

### Patch Changes

- Updated dependencies [6a81de3]
- Updated dependencies [c78098a]
- Updated dependencies [65305a1]
- Updated dependencies [c56bb34]
  - @substrat-run/contracts@0.142.0

## 0.2.5

### Patch Changes

- Updated dependencies [48be1e6]
- Updated dependencies [51bb25b]
  - @substrat-run/contracts@0.141.0

## 0.2.4

### Patch Changes

- Updated dependencies [32df62b]
- Updated dependencies [6154fd9]
- Updated dependencies [6d49012]
- Updated dependencies [55e6241]
- Updated dependencies [13a2067]
- Updated dependencies [72f8e92]
- Updated dependencies [100b47c]
- Updated dependencies [d42bb2b]
- Updated dependencies [e5bd928]
- Updated dependencies [ae80b0d]
- Updated dependencies [a1f40e5]
- Updated dependencies [0e3d406]
- Updated dependencies [fed1f3c]
- Updated dependencies [5405401]
- Updated dependencies [655141a]
- Updated dependencies [f1290ea]
- Updated dependencies [ced5130]
  - @substrat-run/contracts@0.140.0

## 0.2.3

### Patch Changes

- Updated dependencies [2a505df]
- Updated dependencies [ec25a00]
- Updated dependencies [4a14c92]
- Updated dependencies [48bf765]
  - @substrat-run/contracts@0.139.0

## 0.2.2

### Patch Changes

- Updated dependencies [d08b9b1]
- Updated dependencies [f33b1c3]
- Updated dependencies [bc6cc57]
- Updated dependencies [921dfa3]
  - @substrat-run/contracts@0.138.0

## 0.2.1

### Patch Changes

- Updated dependencies [7559e1a]
- Updated dependencies [21055d5]
- Updated dependencies [1c411fc]
- Updated dependencies [fcb587d]
  - @substrat-run/contracts@0.137.0

## 0.2.0

### Minor Changes

- 7418e7e: Previews and forks are inert: a scope that is not primary causes no outbound effects (#2005).

  A fork, a snapshot and a preview of either kind still run their code and commit their writes, but nothing they ask for leaves them. One predicate decides it, `isPrimaryScope`, and every outbound door applies it:

  - The platform-intent drain settles a non-primary scope's own intents `failed`, attributed to the platform, with the new `INERT_SCOPE_REASON`, and runs no handler. The settle lands no ops-failure row. `model-usage` and `sweep-runs` still land, because they record something that already happened. `drainScopePlatformRequests` now takes a `PlatformDrainContext`, which requires the scope's `kind` and `forkedFrom`, and decides from them.
  - Executor and connector dispatch, on both adapters (the emitting call's tail and `drainDue`), journals a non-primary scope's deliveries terminal with the same reason and never runs the handler. `ExecutorDrainReport` gains an optional `inert` count. A CP-less hosted vertical, which has no directory, reads the scope's own copy-origin row instead. Every copy now holds that row, an empty copy included. Every carry onto a non-primary scope marks it (`restoreScope`'s `markCopy`). The new staff route `POST /scopes/mark-copies` (`pnpm scopes:mark-copies`; paged, resumable, dry run, admin-logged as `markScopeCopy`) marks copies made before the row existed, suspended and archived ones included, through the vertical's new `/internal/mark-copy`. Reactivating a copy marks it first. Each marker request carries the directory's classification (`scopeLineage`), and the vertical refuses to mark a primary. `POST /tenants/:t/scopes/:s/clear-copy-mark` (staff, logged as `clearScopeCopyMark`) clears a mistaken mark on an install, through `/internal/clear-copy-mark`.
  - `RouteTarget` gains `primary` (defaulted to `true` for a resolver that predates it). `RouteTarget` also gains `hostnames`, the scope's active hostnames, defaulted to `[]`. The router hands all of it, with the hostname the dispatch serves, to the egress worker. The worker refuses every third-party subrequest from a non-primary scope, and every write to another platform app, metering both as `inert`. Reads of other apps, any request to a hostname of the copy's own scope, and the relay still pass, and each of them leaves with `redirect: 'manual'`, so a redirect cannot carry a copy past the rule.
  - The sweep's schedule and freshness phases filter on `isPrimaryScope`, so a clean-room preview no longer fires its schedules.
  - Previews and forks cannot send email or change a tenant's connections: the email relay, the connection relay (including the route a consent round's callback stores through) and connect-url refuse a non-primary scope with a 403.
  - `isPrimaryScopeRow` answers the same predicate over a raw directory row.

### Patch Changes

- eae3c71: The egress worker no longer lets a redirect take a vertical's request outside its declared outbound surface (#2011). Every request it lets out, whether to a declared host, the platform loopback, the relay or an unenforced version, leaves with `redirect: 'manual'`. The 3xx goes back to the vertical, and the vertical's own `fetch` follows it as a new request that the egress worker checks like any other. Code that relies on `fetch` following redirects between hosts it declared sees the same response, `url` and `redirected` as before. A redirect to an undeclared host now gets the same refusal a direct call there would.

  Each 3xx is also metered as a `redirect` datapoint in `substrat_egress`, beside the verdict that let the request out. Its fourth blob is the host the redirect pointed at.

- Updated dependencies [fb1f624]
- Updated dependencies [4964eb8]
- Updated dependencies [b9b3b82]
- Updated dependencies [3ed9e9d]
- Updated dependencies [cdf32ab]
- Updated dependencies [7a28aea]
- Updated dependencies [7418e7e]
- Updated dependencies [18069f9]
  - @substrat-run/contracts@0.136.0

## 0.1.75

### Patch Changes

- Updated dependencies [1dca2da]
- Updated dependencies [8c64633]
- Updated dependencies [5d41454]
  - @substrat-run/contracts@0.135.0

## 0.1.74

### Patch Changes

- Updated dependencies [4347933]
  - @substrat-run/contracts@0.134.0

## 0.1.73

### Patch Changes

- Updated dependencies [a08c42e]
  - @substrat-run/contracts@0.133.0

## 0.1.72

### Patch Changes

- @substrat-run/contracts@0.132.0

## 0.1.71

### Patch Changes

- Updated dependencies [012b2c8]
  - @substrat-run/contracts@0.131.0

## 0.1.70

### Patch Changes

- Updated dependencies [b53ecff]
- Updated dependencies [8236531]
  - @substrat-run/contracts@0.130.0

## 0.1.69

### Patch Changes

- Updated dependencies [b213bfc]
  - @substrat-run/contracts@0.129.0

## 0.1.68

### Patch Changes

- Updated dependencies [260fb5a]
- Updated dependencies [4ba2a52]
- Updated dependencies [f79e8ba]
- Updated dependencies [ba75c81]
  - @substrat-run/contracts@0.128.0

## 0.1.67

### Patch Changes

- @substrat-run/contracts@0.127.0

## 0.1.66

### Patch Changes

- Updated dependencies [6d57761]
- Updated dependencies [c78e713]
- Updated dependencies [e1526a0]
  - @substrat-run/contracts@0.126.0

## 0.1.65

### Patch Changes

- Updated dependencies [e8d4860]
  - @substrat-run/contracts@0.125.0

## 0.1.64

### Patch Changes

- Updated dependencies [02942e0]
- Updated dependencies [45421e8]
  - @substrat-run/contracts@0.124.0

## 0.1.63

### Patch Changes

- Updated dependencies [f56e9eb]
- Updated dependencies [6b3cb45]
- Updated dependencies [ae19d01]
- Updated dependencies [30b09c6]
  - @substrat-run/contracts@0.123.0

## 0.1.62

### Patch Changes

- Updated dependencies [0803833]
  - @substrat-run/contracts@0.122.0

## 0.1.61

### Patch Changes

- Updated dependencies [a235648]
- Updated dependencies [6fc9950]
- Updated dependencies [48fea30]
- Updated dependencies [45b927e]
  - @substrat-run/contracts@0.121.0

## 0.1.60

### Patch Changes

- @substrat-run/contracts@0.120.0

## 0.1.59

### Patch Changes

- 8009cd1: A deployed vertical can now call another vertical of the same tenant. The platform says which app is calling, so the caller holds no credential (#1706, part 2: the hosted transport). Part 1 built the door; this is the path to it.

  **What a vertical author writes.** The caller declares who it calls, in package.json:

  ```json
  { "substrat": { "calls": ["acme/crm"] } }
  ```

  and calls it from its harness:

  ```ts
  const result = await peerClient("acme/crm").invoke("customer/list", {
    limit: 50,
  });
  ```

  There is no address, no token and no outbound-allowlist entry. What the caller may then DO is the target's own `peers` declaration, which its permission diff reviews.

  **How the platform knows who is calling.** The call goes to one reserved address, `peer.substrat.internal`, which is in no DNS zone:

  - the **egress worker** — which every dispatched `fetch` passes through — recognises that address before its outbound policy and hands the call to the router, with the caller taken from the dispatch parameters the router set when it dispatched the caller. Nothing in the request contributes to it, and the body is strict, so it cannot carry one;
  - the **router**'s `PeerCalls` entrypoint (reachable only through a service binding, never over its public `fetch`) resolves the target in the caller's own tenant and dispatches the target's `/internal/vertical-invoke`;
  - a call made where egress cannot see it — from inside a Durable Object, which outbound workers do not intercept — **fails to resolve** instead of leaving the isolate. That is why the address is unroutable rather than real.

  **Module code reaches a peer asynchronously.** An operation, a consumer or a schedule runs inside the scope's Durable Object, where module code has no network by rule. It enqueues a `peer-invoke` platform intent instead (`ctx.requestPlatform`), and the control plane's drain delivers it with the caller taken from the scope it found the row in. At-least-once, with the intent id as the idempotency key.

  **The gates, on both legs:**

  - the caller's declared `substrat.calls` (a version pushed before the declaration carries `null` and is unenforced, exactly as a pre-#303 `outbound` is);
  - the caller is a live, primary instance of the vertical it claims — never a preview, and the refusal names the local broker as the way to test the edge;
  - the target resolves to exactly one primary, active instance **in the caller's tenant**, never guessed when a tenant runs two;
  - a synchronous chain is bounded by `PEER_CALL_DEPTH_MAX`, its own constant, deliberately not shared with #1705's event hop cap.

  **Contract additions.** `@substrat-run/contracts` adds `peer-transport.ts` (`PEER_CALL_HOST`, `PEER_CALL_URL`, `isPeerCallHost`, `PEER_CALL_DEPTH_MAX`, `peerCallRequest`, `peerCaller`, `callsDeclares` and the refusal messages) and the `peer-invoke` intent kind with its payload. The deploy manifest, `RouteTarget` and the version record each gain `calls` beside `outbound`, lifted from the stored manifest by `callsOfManifestJson`. `@substrat-run/vertical-host` exports `peerClient`; `@substrat-run/control-plane-api` adds `VerticalClient.verticalInvoke` and `peerInvokeHandler`; the Cloudflare adapter adds `createPeerCallResolver` and the directory's `peerCallTarget` read.

  **Operators:** the egress worker needs its new `PEER_CALLS` binding to the router's `PeerCalls` entrypoint, and the router now deploys from `src/index.ts` (which exports both the fetch handler and that entrypoint). Without the binding, peer calls are refused — never passed through.

  The console scope page and dashboard app page now show incoming peer access and offer cut-off/restore controls with an audited reason. Hosted switch/status calls delegate to the deployment holding the grants. The dashboard also discloses outgoing targets after installation, keeping missing targets, refused access and unreadable status distinct. `peersDeclaredBy` derives peer permissions from the model's operations. The architecture guide includes an executable local call/cut-off/restore example and operator rollout steps.

  Instance binding when a tenant runs multiple active targets remains excluded, tracked in #1720; ambiguous calls are refused.

- Updated dependencies [bb10d6d]
- Updated dependencies [929ec09]
- Updated dependencies [a9cfc4a]
- Updated dependencies [2c65b67]
- Updated dependencies [8009cd1]
- Updated dependencies [b080e0f]
- Updated dependencies [e7113ea]
  - @substrat-run/contracts@0.119.0

## 0.1.58

### Patch Changes

- Updated dependencies [030fafd]
- Updated dependencies [56a931b]
- Updated dependencies [429cc84]
  - @substrat-run/contracts@0.118.0

## 0.1.57

### Patch Changes

- Updated dependencies [6504a99]
- Updated dependencies [aabc227]
- Updated dependencies [fb37a3e]
- Updated dependencies [44299a1]
- Updated dependencies [d7eb089]
- Updated dependencies [105a4c3]
- Updated dependencies [a8c2c64]
- Updated dependencies [2fa5147]
- Updated dependencies [1f223f5]
  - @substrat-run/contracts@0.117.0

## 0.1.56

### Patch Changes

- Updated dependencies [e22db55]
- Updated dependencies [a67c59b]
- Updated dependencies [45d2f15]
- Updated dependencies [e99332e]
  - @substrat-run/contracts@0.116.0

## 0.1.55

### Patch Changes

- Updated dependencies [1a6fe4d]
  - @substrat-run/contracts@0.115.0

## 0.1.54

### Patch Changes

- Updated dependencies [f58aa74]
  - @substrat-run/contracts@0.114.0

## 0.1.53

### Patch Changes

- Updated dependencies [c146761]
- Updated dependencies [c3c92e9]
- Updated dependencies [2fc7187]
- Updated dependencies [7e6f925]
  - @substrat-run/contracts@0.113.0

## 0.1.52

### Patch Changes

- Updated dependencies [c697b15]
- Updated dependencies [db6a96f]
- Updated dependencies [221f94a]
  - @substrat-run/contracts@0.112.0

## 0.1.51

### Patch Changes

- Updated dependencies [f08bfc4]
- Updated dependencies [aaafae3]
- Updated dependencies [1b2506c]
  - @substrat-run/contracts@0.111.0

## 0.1.50

### Patch Changes

- Updated dependencies [a195037]
- Updated dependencies [8758949]
- Updated dependencies [d05689d]
- Updated dependencies [0257dbd]
- Updated dependencies [cb88aa1]
  - @substrat-run/contracts@0.110.0

## 0.1.49

### Patch Changes

- Updated dependencies [7aa3ea5]
- Updated dependencies [1e175ce]
  - @substrat-run/contracts@0.109.0

## 0.1.48

### Patch Changes

- Updated dependencies [5cf7ae4]
- Updated dependencies [44b53e4]
  - @substrat-run/contracts@0.108.0

## 0.1.47

### Patch Changes

- Updated dependencies [4a6c4c3]
  - @substrat-run/contracts@0.107.0

## 0.1.46

### Patch Changes

- @substrat-run/contracts@0.106.0

## 0.1.45

### Patch Changes

- @substrat-run/contracts@0.105.0

## 0.1.44

### Patch Changes

- Updated dependencies [dd999a9]
  - @substrat-run/contracts@0.104.0

## 0.1.43

### Patch Changes

- Updated dependencies [dc9995c]
- Updated dependencies [adf6bfb]
  - @substrat-run/contracts@0.103.0

## 0.1.42

### Patch Changes

- Updated dependencies [e7115b2]
- Updated dependencies [3e67ebe]
  - @substrat-run/contracts@0.102.0

## 0.1.41

### Patch Changes

- Updated dependencies [b61c4d5]
- Updated dependencies [306b893]
  - @substrat-run/contracts@0.101.0

## 0.1.40

### Patch Changes

- Updated dependencies [0cd3055]
- Updated dependencies [4b159da]
- Updated dependencies [d1a5a58]
- Updated dependencies [8912fb8]
- Updated dependencies [6b3e466]
  - @substrat-run/contracts@0.100.0

## 0.1.39

### Patch Changes

- Updated dependencies [e398034]
- Updated dependencies [28a82c0]
- Updated dependencies [d124e9a]
- Updated dependencies [8e29866]
- Updated dependencies [02793d9]
  - @substrat-run/contracts@0.99.0

## 0.1.38

### Patch Changes

- Updated dependencies [05de166]
- Updated dependencies [07203fb]
  - @substrat-run/contracts@0.98.0

## 0.1.37

### Patch Changes

- Updated dependencies [9fcfebc]
  - @substrat-run/contracts@0.97.0

## 0.1.36

### Patch Changes

- Updated dependencies [db5a3da]
  - @substrat-run/contracts@0.96.0

## 0.1.35

### Patch Changes

- Updated dependencies [f065a84]
- Updated dependencies [7bf77df]
  - @substrat-run/contracts@0.95.0

## 0.1.34

### Patch Changes

- Updated dependencies [692cb92]
- Updated dependencies [c9f3bac]
- Updated dependencies [e6dbb7b]
- Updated dependencies [568ba88]
- Updated dependencies [35147a9]
  - @substrat-run/contracts@0.94.0

## 0.1.33

### Patch Changes

- Updated dependencies [722c2cc]
- Updated dependencies [df4ffd1]
  - @substrat-run/contracts@0.93.0

## 0.1.32

### Patch Changes

- Updated dependencies [7843c4f]
  - @substrat-run/contracts@0.92.0

## 0.1.31

### Patch Changes

- Updated dependencies [75bd27c]
  - @substrat-run/contracts@0.91.0

## 0.1.30

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0

## 0.1.29

### Patch Changes

- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/contracts@0.89.0

## 0.1.28

### Patch Changes

- Updated dependencies [e401927]
- Updated dependencies [04c61c1]
- Updated dependencies [d4c66ac]
- Updated dependencies [6d71731]
- Updated dependencies [1c1f23c]
- Updated dependencies [b3c362d]
  - @substrat-run/contracts@0.88.0

## 0.1.27

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0

## 0.1.26

### Patch Changes

- @substrat-run/contracts@0.86.0

## 0.1.25

### Patch Changes

- @substrat-run/contracts@0.85.0

## 0.1.24

### Patch Changes

- Updated dependencies [716a9df]
- Updated dependencies [5b7fbc0]
- Updated dependencies [946dd47]
  - @substrat-run/contracts@0.84.0

## 0.1.23

### Patch Changes

- Updated dependencies [ca3377d]
  - @substrat-run/contracts@0.83.0

## 0.1.22

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0

## 0.1.21

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0

## 0.1.20

### Patch Changes

- Updated dependencies [83b0ca3]
  - @substrat-run/contracts@0.80.0

## 0.1.19

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
  - @substrat-run/contracts@0.79.0

## 0.1.18

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0

## 0.1.17

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0

## 0.1.16

### Patch Changes

- @substrat-run/contracts@0.76.0

## 0.1.15

### Patch Changes

- @substrat-run/contracts@0.75.0

## 0.1.14

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0

## 0.1.13

### Patch Changes

- Updated dependencies [3b8533d]
  - @substrat-run/contracts@0.73.0

## 0.1.12

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/contracts@0.72.0

## 0.1.11

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0

## 0.1.10

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0

## 0.1.9

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0

## 0.1.8

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
  - @substrat-run/contracts@0.68.0

## 0.1.7

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
  - @substrat-run/contracts@0.67.0

## 0.1.6

### Patch Changes

- @substrat-run/contracts@0.66.0

## 0.1.5

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0

## 0.1.4

### Patch Changes

- Updated dependencies [c19e371]
  - @substrat-run/contracts@0.64.0

## 0.1.3

### Patch Changes

- @substrat-run/contracts@0.63.0

## 0.1.2

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0

## 0.1.1

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0

## 0.1.0

### Minor Changes

- 3ee5903: feat: outbound network policy for hosted verticals — a declared per-version allowlist, enforced at the egress worker and metered on every verdict (D-46, closes #303)

  Egress from a hosted worker runs under the platform's Cloudflare account — an
  SSRF/exfiltration and cost/abuse surface — yet every dispatched `fetch()` passed
  through the egress worker (#442) untouched, and self-serve-deploy.md §6.3 left
  the policy an explicit open question. Answered: **allowlist and metered**, with
  the allowlist being the vertical's own declaration, reviewed at the admit
  checkpoint like the permission surface.

  - **Declaration** (`contracts`): `substrat.outbound` in the vertical's
    package.json — exact lowercase hostnames plus `*.`-wildcards (any subdomain
    depth, never the apex); `outboundHost` schema, `matchesOutboundHost` matcher
    (one implementation for every seam that asks), `outbound` on the deploy
    manifest, and the list lifted onto the version record so a list view never
    parses whole manifests.
  - **CLI**: carries the declaration on push and preview, and **always** sends it
    — `[]` when undeclared, because no direct third-party egress is the correct
    default (connectors run platform-side, mail rides the `emailSender` relay,
    cross-vertical calls ride the router).
  - **Resolution** (both adapters): `readHostname`/`resolveHostname` join the
    declared list of _the version whose code the dispatch runs_ — the serving
    version when the stable serving script wins, the bound version on the
    per-version fallback — as `RouteTarget.outboundHosts`, via `json_extract` so
    the hot path stays one directory read.
  - **Router**: passes `{ slug, tenant, hosts }` as the `OUTBOUND_POLICY` outbound
    dispatch parameter (`dispatch_namespaces[].outbound.parameters`).
  - **Egress worker**: platform hosts keep looping through the router (K-27),
    declared hosts pass untouched, anything else is a 403 whose body names the
    host and says what to declare. A pre-#303 version resolves `hosts: null` and
    passes through unenforced until its next push — least privilege arrives
    version by version, never as a fleet outage. Every verdict
    (`platform`/`allowed`/`unenforced`/`refused`) writes one Analytics Engine
    datapoint (`substrat_egress`, index = slug; D-30 meter-don't-bill), so the
    unenforced tail and any refusal spike are charts, not guesses.
  - **Console**: the version table renders the declared surface beside the Admit
    button — `none`, the host list, or `undeclared (unenforced)`.

  Honest limit, published with the mechanism (self-serve-deploy.md §4.2):
  Cloudflare outbound workers do not intercept Durable-Object-originated
  subrequests, so DO-context fetches bypass enforcement today — worker-context
  egress is what is policed, and the declared list remains the reviewed contract
  for all of it. Attaching an outbound worker does disable raw TCP `connect()`
  for every dispatched script.

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0

## 0.0.1

### Patch Changes

- 714ccf4: Cross-vertical HTTP now works: a dispatched vertical calling another vertical's public
  `*.substrat.run` API used to 522 at the same-zone edge, because a same-zone worker
  subrequest never re-enters the router (#442). The concrete casualty was OIDC — the
  AuthHero console fetching its issuer's JWKS from another vertical on our own zone timed
  out, so every valid login 401'd.

  Adds `@substrat-run/vertical-egress`, a Workers-for-Platforms **outbound worker** bound
  to the `substrat-verticals` dispatch namespace. Every dispatched vertical's `fetch()` is
  routed through it: platform-bound egress (any host that is or ends in `PLATFORM_BASE_DOMAINS`)
  is handed back to the router over a service binding — a direct in-process call that dodges
  the same-zone loopback and re-enters normal resolution+dispatch — and everything else passes
  straight through to the public internet, untouched. This keeps K-27 intact (a vertical still
  reaches the platform only through the router) and needs no vertical code change.

  Scoped to the router's dispatch binding (the login path). The control plane's dispatch
  binding is deliberately left alone — its dispatched calls are internal provisioning, not
  cross-vertical public HTTP, and wiring it would create a deploy-order cycle (it deploys
  first). The caller-identity half — who may call whom — is #303's outbound network policy,
  which layers on this worker later via the binding's outbound `parameters`.
