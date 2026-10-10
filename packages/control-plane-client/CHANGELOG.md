# @substrat-run/control-plane-client

## 0.1.7

### Patch Changes

- 6a00cfc: **`ControlPlaneError#problemCode`** reads the taxonomy code the plane's problem document declared (#113), so a caller can branch on what a refusal is instead of on its sentence. It is `undefined` for a body that named no code: an `about:blank` relay, a route the plane does not have, a transport error, or an error raised on the caller's side.

  **`vertical-host`'s `/internal/query`** recognises the read-only console's refusal by its `validation_failed` code instead of the words `read-only console`. The status (400) and the sentence are unchanged.

- Updated dependencies [6a81de3]
- Updated dependencies [c78098a]
- Updated dependencies [65305a1]
- Updated dependencies [c56bb34]
  - @substrat-run/contracts@0.142.0

## 0.1.6

### Patch Changes

- Updated dependencies [48be1e6]
- Updated dependencies [51bb25b]
  - @substrat-run/contracts@0.141.0

## 0.1.5

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

## 0.1.4

### Patch Changes

- Updated dependencies [2a505df]
- Updated dependencies [ec25a00]
- Updated dependencies [4a14c92]
- Updated dependencies [48bf765]
  - @substrat-run/contracts@0.139.0

## 0.1.3

### Patch Changes

- Updated dependencies [d08b9b1]
- Updated dependencies [f33b1c3]
- Updated dependencies [bc6cc57]
- Updated dependencies [921dfa3]
  - @substrat-run/contracts@0.138.0

## 0.1.2

### Patch Changes

- Updated dependencies [7559e1a]
- Updated dependencies [21055d5]
- Updated dependencies [1c411fc]
- Updated dependencies [fcb587d]
  - @substrat-run/contracts@0.137.0

## 0.1.1

### Patch Changes

- 33b2d44: A refused connect's `ControlPlaneError` now carries the provider `probe` its body named (#605), read off the same parse as the sentence. The field was declared and documented but never filled, so every caller had to re-read the body for it.
- 4eb961d: `npx @substrat-run/cli` installs again. `@substrat-run/control-plane-client@0.1.0` was published with a `workspace:` dependency that npm cannot resolve, so installing the CLI failed with `EUNSUPPORTEDPROTOCOL`. This release republishes the client with a resolvable manifest, and the CLI now requires that version.
- 01bf5d4: A kill switch whose answer was cut short no longer reports "Nothing was switched" (#2010).
  When a deployment that has the switch route moved the switch and then lost part of its
  answer (a truncated body, or one that failed to read), the control plane said the deployment
  predated the route and told the operator to redeploy and retry. Now only a status says a
  deployment predates a route: a 404, or a 501 where that deployment's own fallback answers one.
  A body never does. An HTML page in particular can't count, because an old deployment's app
  page and an error page from something in between look the same. Anything else is a 502 that
  says the position is unknown and to read it before retrying. The same rule covers the
  switch status reads, the preview-client calls to a team auth server, the cross-vertical event
  calls, the plain internal calls, and the carry's fenced wipe.

  The console's Schedules and Peers cards and the dashboard's app-to-app panel no longer show
  such a failure as "Refused". They read the position again, show it, and say the switch was
  not confirmed.

  `@substrat-run/control-plane-client` exports `provesNothingChanged(error)`, the one rule both apps
  use to tell a refusal (4xx, or 501) from a failure whose effect is unknown.

- Updated dependencies [fb1f624]
- Updated dependencies [4964eb8]
- Updated dependencies [b9b3b82]
- Updated dependencies [3ed9e9d]
- Updated dependencies [cdf32ab]
- Updated dependencies [7a28aea]
- Updated dependencies [7418e7e]
- Updated dependencies [18069f9]
  - @substrat-run/contracts@0.136.0

## 0.1.0

### Minor Changes

- 04f105e: The control-plane client is its own Apache-2.0 package, and the CLI talks to the plane through it (part of #971).

  `@substrat-run/control-plane-client` holds the transport (credential selection, the problem-document reader, `ControlPlaneError`) and `ControlPlaneClient`, reaching nothing but `fetch` and `@substrat-run/contracts`. `@substrat-run/control-plane-api` re-exports it from both entries, so every existing import keeps working; the CLI depends on the client rather than on the AGPL server package. The transport gains an optional `headers` option, `ControlPlaneError` carries the raw `body`, `statusText` and response `headers` of a refusal (and the error `fetch` threw as its `cause`), a raw `request()` hands back the `Response`, and `fetch` is resolved at call time; `ControlPlaneBuilderClient` adds typed methods for the routes the CLI calls. Nothing a deployed caller sends or reads changes, and the CLI prints the same requests and the same messages as before.

### Patch Changes

- Updated dependencies [1dca2da]
- Updated dependencies [8c64633]
- Updated dependencies [5d41454]
  - @substrat-run/contracts@0.135.0
