# @substrat-run/social-relay

## 0.2.9

### Patch Changes

- Updated dependencies [ad35e20]
- Updated dependencies [60eb041]
- Updated dependencies [2eedfee]
  - @substrat-run/kernel@0.163.0
  - @substrat-run/contracts@0.163.0

## 0.2.8

### Patch Changes

- Updated dependencies [3310b4d]
- Updated dependencies [7d71f13]
  - @substrat-run/kernel@0.162.0
  - @substrat-run/contracts@0.162.0

## 0.2.7

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

## 0.2.6

### Patch Changes

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

## 0.2.5

### Patch Changes

- Updated dependencies [6aad0fb]
  - @substrat-run/contracts@0.159.0
  - @substrat-run/kernel@0.159.0

## 0.2.4

### Patch Changes

- @substrat-run/contracts@0.158.0
- @substrat-run/kernel@0.158.0

## 0.2.3

### Patch Changes

- Updated dependencies [d0af665]
- Updated dependencies [156febd]
  - @substrat-run/contracts@0.157.0
  - @substrat-run/kernel@0.157.0

## 0.2.2

### Patch Changes

- Updated dependencies [8bbf7e9]
- Updated dependencies [c5052f9]
- Updated dependencies [55a4dae]
- Updated dependencies [1344288]
  - @substrat-run/kernel@0.156.0
  - @substrat-run/contracts@0.156.0

## 0.2.1

### Patch Changes

- Updated dependencies [6933146]
- Updated dependencies [35bdba2]
- Updated dependencies [10b7e03]
  - @substrat-run/contracts@0.155.0
  - @substrat-run/kernel@0.155.0

## 0.2.0

### Minor Changes

- 1872bb7: An Auth Server install now gets platform-provided social sign-in without anyone registering anything: GitHub (and later Google and Apple) through the platform's social relay at `id.substrat.net`, offered on the install's **Sign-in providers** screen as a switch that starts off (#1544).

  **Auth Server.** A new platform delivery, `substrat:social-relay`, carries the install's client at the relay and the providers the relay serves. Each provider becomes a `<provider>-relay` sign-in provider, created switched off.

  - A later delivery keeps the operator's three decisions (enabled, creates accounts, trusted email) and replaces only what the platform owns.
  - A provider of the operator's own under the same id is never touched. One configured against the relay by hand is adopted.
  - A provider the relay stops serving is switched off.
  - On the screen, these providers say "provided by Substrat". They show the switches and no credential form, and cannot be removed, only switched off.
  - A delivery without a secret keeps the one held. When none is held, `/internal/configure` answers 409 `social_relay_secret_needed`.

  **Control plane.** `socialRelay` on `createControlPlaneApi` reconciles one install's client at the relay:

  - It reads the relay's live providers and builds callbacks from the install's active hostnames. A custom domain counts only once Cloudflare reports it verified, asked at that moment.
  - It ensures the client under `scope:<scope id>` and delivers the entry. The secret is rotated only when the install answers that it holds none.
  - It runs when a hostname of an Auth Server install becomes active, through the bind, verify and status routes and the hostname sweep (`reconcilePendingHostnames` takes `onActivated`). That covers install time and every custom domain.
  - Two staff-only routes, `POST /tenants/:t/scopes/:s/social-relay` and `POST /social-relay/reconcile`, reconcile one install or all of them, for example after the relay gains a provider.
  - The worker reaches the relay through a `SOCIAL_RELAY` service binding, with `SOCIAL_RELAY_ORIGIN` set per environment.

  **Relay.** New endpoints:

  - `GET /providers` lists the providers it can serve, with their endpoints.
  - `PUT /internal/clients/by-ref/:ref` ensures one client per install, returning the secret only on create.
  - `POST /internal/clients/:id/secret` rotates a client's secret.
  - A client now takes up to 64 redirect URIs.
  - A disabled client stays disabled through any reconcile.

### Patch Changes

- Updated dependencies [bf18880]
- Updated dependencies [34c4455]
- Updated dependencies [34c4455]
- Updated dependencies [1872bb7]
  - @substrat-run/contracts@0.154.0
  - @substrat-run/kernel@0.154.0

## 0.1.37

### Patch Changes

- Updated dependencies [1a064a0]
  - @substrat-run/kernel@0.153.0
  - @substrat-run/contracts@0.153.0

## 0.1.36

### Patch Changes

- Updated dependencies [482e9b7]
  - @substrat-run/contracts@0.152.0
  - @substrat-run/kernel@0.152.0

## 0.1.35

### Patch Changes

- Updated dependencies [8273013]
- Updated dependencies [4efc88d]
- Updated dependencies [a667881]
- Updated dependencies [f614b00]
- Updated dependencies [a00c87a]
  - @substrat-run/contracts@0.151.0
  - @substrat-run/kernel@0.151.0

## 0.1.34

### Patch Changes

- Updated dependencies [57700ea]
- Updated dependencies [52cc41f]
- Updated dependencies [9024575]
- Updated dependencies [5f77e74]
  - @substrat-run/kernel@0.150.0
  - @substrat-run/contracts@0.150.0

## 0.1.33

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

## 0.1.32

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

## 0.1.31

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

## 0.1.30

### Patch Changes

- Updated dependencies [381f120]
- Updated dependencies [a55d75e]
- Updated dependencies [56b0af0]
  - @substrat-run/contracts@0.146.0
  - @substrat-run/kernel@0.146.0

## 0.1.29

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

## 0.1.28

### Patch Changes

- Updated dependencies [835409e]
- Updated dependencies [f84eb3a]
- Updated dependencies [e286f87]
- Updated dependencies [f6d671b]
- Updated dependencies [134e6c2]
- Updated dependencies [6dc8097]
  - @substrat-run/contracts@0.144.0
  - @substrat-run/kernel@0.144.0

## 0.1.27

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

## 0.1.26

### Patch Changes

- c78098a: **Breaking:** the kernel no longer exports the host-side code it deprecated in 0.136.0 (part of #1978). The code now lives in its new homes. If you still import one of these names from `@substrat-run/kernel`, import it from the package below; it is the same function.

  - **`@substrat-run/vertical-host`**: `invocationLog`, `withInvocationLog`, `invocationStampOf`, `fieldCoverageArmed`, `INVOCATION_RECORD_KEY`, `readRoutedNode`, `RouterAssertionError`, `kickFlags`, `assertPlatformCall`, `PlatformCallError`, and the types `InvocationLogContext`, `InvocationRecord`, `InvocationStamp`, `ModuleWorker`, `IncomingRequest`, `RoutedNode`, `HeaderReader` and `ReadRoutedNodeOptions`.
  - **`@substrat-run/adapter-cloudflare`**: `analyticsEngineConnectorCallRecorder`, `CONNECTOR_CALL_DATA_POINT_LAYOUT`, `connectorCallDataPoint` and `AnalyticsEngineDatasetLike`.
  - **`@substrat-run/control-plane-api`**: `isTerminalDispatchFailure`, `isTerminalProviderError`, `providerErrorStatus` and `RETRYABLE_CLIENT_STATUSES`.
  - **`@substrat-run/contracts/wire-auth`**, a new subpath: `assertPlatformCall` and `PlatformCallError`, defined here now because the control plane and the social relay check platform calls too. `@substrat-run/vertical-host` re-exports both, so a vertical's import is unchanged. The subpath also exports `secretMatches`, the constant-time compare behind both platform-call and router-assertion checks. It now compares in time independent of the presented value, with the same results as before.
  - **`@substrat-run/contracts`**: `invocationLevelOf`, `InvocationLevel`, `LIVE_MODE_HEADER`, `LiveRefusal`, `PLATFORM_SECRET_HEADER`, `PLATFORM_REQUEST_HEADER`, `EXPORTED_EVENTS_HEADER` and `CONNECTOR_ATTACHMENT_RECORD_HEADER`.

  Two deprecations are withdrawn, and these names stay in the kernel:

  - **The invocation line's shape** (`InvocationLogLine`, `OutputFieldsReport`) stays, beside `invocationLine`, because the scope host writes the consumer and schedule lines with it. `@substrat-run/vertical-host` still re-exports both types. The kernel also gains two subpaths that import nothing at run time, for code bundled in front of every vertical: `@substrat-run/kernel/invocation-line` and `@substrat-run/kernel/ulid`.
  - **`isUpgradeRequest`** stays beside the `LiveReadSurface` contract, because the hosted adapter's live-read door uses it too. `@substrat-run/vertical-host` still re-exports it.

  Nothing a deployed vertical sends, reads or logs changes. The entry module the platform uploads in front of every vertical is now built from `@substrat-run/vertical-host`, and its code is the same.

- Updated dependencies [6a81de3]
- Updated dependencies [c78098a]
- Updated dependencies [65305a1]
- Updated dependencies [c56bb34]
  - @substrat-run/contracts@0.142.0
  - @substrat-run/kernel@0.142.0

## 0.1.25

### Patch Changes

- Updated dependencies [48be1e6]
- Updated dependencies [6a05977]
  - @substrat-run/kernel@0.141.0

## 0.1.24

### Patch Changes

- Updated dependencies [35dc72e]
- Updated dependencies [32df62b]
- Updated dependencies [6154fd9]
- Updated dependencies [6d49012]
- Updated dependencies [55e6241]
- Updated dependencies [13a2067]
- Updated dependencies [7b15101]
- Updated dependencies [72f8e92]
- Updated dependencies [d42bb2b]
- Updated dependencies [e5bd928]
- Updated dependencies [b180d3e]
- Updated dependencies [07388df]
- Updated dependencies [ae80b0d]
- Updated dependencies [a1f40e5]
- Updated dependencies [0e3d406]
- Updated dependencies [5405401]
- Updated dependencies [655141a]
- Updated dependencies [f1290ea]
- Updated dependencies [ced5130]
  - @substrat-run/kernel@0.140.0

## 0.1.23

### Patch Changes

- Updated dependencies [d62f6fb]
- Updated dependencies [98492af]
- Updated dependencies [2a505df]
- Updated dependencies [ec25a00]
- Updated dependencies [4a14c92]
- Updated dependencies [d55b4cd]
- Updated dependencies [48bf765]
  - @substrat-run/kernel@0.139.0

## 0.1.22

### Patch Changes

- Updated dependencies [d5739ca]
- Updated dependencies [50ce5e0]
- Updated dependencies [59972cb]
- Updated dependencies [6476e71]
- Updated dependencies [d08b9b1]
- Updated dependencies [f33b1c3]
- Updated dependencies [921dfa3]
  - @substrat-run/kernel@0.138.0

## 0.1.21

### Patch Changes

- Updated dependencies [7559e1a]
- Updated dependencies [21055d5]
- Updated dependencies [b641075]
- Updated dependencies [7adf5c7]
- Updated dependencies [1c411fc]
  - @substrat-run/kernel@0.137.0

## 0.1.20

### Patch Changes

- Updated dependencies [1af2d47]
- Updated dependencies [4fdad69]
- Updated dependencies [4964eb8]
- Updated dependencies [30c2cda]
- Updated dependencies [b9b3b82]
- Updated dependencies [3ed9e9d]
- Updated dependencies [cdf32ab]
- Updated dependencies [7418e7e]
- Updated dependencies [18069f9]
  - @substrat-run/kernel@0.136.0

## 0.1.19

### Patch Changes

- Updated dependencies [8267b83]
- Updated dependencies [1dca2da]
- Updated dependencies [3328549]
- Updated dependencies [8c64633]
- Updated dependencies [5d41454]
  - @substrat-run/kernel@0.135.0

## 0.1.18

### Patch Changes

- Updated dependencies [176fe60]
- Updated dependencies [4347933]
- Updated dependencies [1addd27]
- Updated dependencies [560eec4]
  - @substrat-run/kernel@0.134.0

## 0.1.17

### Patch Changes

- Updated dependencies [8a32578]
- Updated dependencies [c74c091]
- Updated dependencies [a128e65]
  - @substrat-run/kernel@0.133.0

## 0.1.16

### Patch Changes

- @substrat-run/kernel@0.132.0

## 0.1.15

### Patch Changes

- Updated dependencies [012b2c8]
- Updated dependencies [56091f8]
- Updated dependencies [e5c21fc]
  - @substrat-run/kernel@0.131.0

## 0.1.14

### Patch Changes

- Updated dependencies [65a0690]
- Updated dependencies [b53ecff]
- Updated dependencies [8236531]
  - @substrat-run/kernel@0.130.0

## 0.1.13

### Patch Changes

- Updated dependencies [b213bfc]
  - @substrat-run/kernel@0.129.0

## 0.1.12

### Patch Changes

- Updated dependencies [260fb5a]
- Updated dependencies [4a53af7]
- Updated dependencies [4ba2a52]
- Updated dependencies [f79e8ba]
- Updated dependencies [ba75c81]
  - @substrat-run/kernel@0.128.0

## 0.1.11

### Patch Changes

- Updated dependencies [2f1e5f5]
- Updated dependencies [b6248b0]
  - @substrat-run/kernel@0.127.0

## 0.1.10

### Patch Changes

- Updated dependencies [6d57761]
- Updated dependencies [c78e713]
  - @substrat-run/kernel@0.126.0

## 0.1.9

### Patch Changes

- Updated dependencies [e8d4860]
- Updated dependencies [9ebacee]
  - @substrat-run/kernel@0.125.0

## 0.1.8

### Patch Changes

- Updated dependencies [90d0f02]
- Updated dependencies [02942e0]
- Updated dependencies [931b8d6]
- Updated dependencies [558f103]
  - @substrat-run/kernel@0.124.0

## 0.1.7

### Patch Changes

- Updated dependencies [6b3cb45]
- Updated dependencies [ae19d01]
- Updated dependencies [30b09c6]
- Updated dependencies [d423d10]
- Updated dependencies [bd8f408]
  - @substrat-run/kernel@0.123.0

## 0.1.6

### Patch Changes

- Updated dependencies [0803833]
- Updated dependencies [1e326dd]
- Updated dependencies [3a3338d]
  - @substrat-run/kernel@0.122.0

## 0.1.5

### Patch Changes

- Updated dependencies [a235648]
- Updated dependencies [6fc9950]
- Updated dependencies [48fea30]
- Updated dependencies [a6f4db1]
- Updated dependencies [45b927e]
  - @substrat-run/kernel@0.121.0

## 0.1.4

### Patch Changes

- Updated dependencies [1de077d]
  - @substrat-run/kernel@0.120.0

## 0.1.3

### Patch Changes

- Updated dependencies [bc6a6bb]
- Updated dependencies [84b5fe2]
- Updated dependencies [929ec09]
- Updated dependencies [a9cfc4a]
- Updated dependencies [2c65b67]
- Updated dependencies [8009cd1]
- Updated dependencies [b080e0f]
  - @substrat-run/kernel@0.119.0

## 0.1.2

### Patch Changes

- Updated dependencies [56a931b]
  - @substrat-run/kernel@0.118.0

## 0.1.1

### Patch Changes

- Updated dependencies [6504a99]
- Updated dependencies [aabc227]
- Updated dependencies [fb37a3e]
- Updated dependencies [44299a1]
- Updated dependencies [4ef164c]
- Updated dependencies [269fa7a]
- Updated dependencies [105a4c3]
- Updated dependencies [a8c2c64]
- Updated dependencies [02c181a]
- Updated dependencies [2fa5147]
- Updated dependencies [1f223f5]
  - @substrat-run/kernel@0.117.0

## 0.1.0

### Minor Changes

- 0ab0d64: Add the platform's social sign-in relay: one OAuth client per upstream (Google, GitHub,
  Apple), held in a worker with no tenant-controllable config, behind one OIDC issuer per
  provider. An installed Auth Server can federate to it as an ordinary generic upstream and
  offer social sign-in without its team ever creating, holding or rotating a provider
  credential — what the install holds is its own client at the relay, which is worth nothing
  anywhere else. The relay keeps no users, no sessions and no cookie, renders no UI beyond an
  error it cannot safely redirect, and registers clients only for the platform.

### Patch Changes

- Updated dependencies [e22db55]
- Updated dependencies [a67c59b]
- Updated dependencies [45d2f15]
- Updated dependencies [e99332e]
- Updated dependencies [1c55458]
- Updated dependencies [0b993ff]
  - @substrat-run/kernel@0.116.0
