# @substrat-run/control-plane-client

## 0.1.1

### Patch Changes

- 33b2d44: A refused connect's `ControlPlaneError` now carries the provider `probe` its body named (#605), read off the same parse as the sentence. The field was declared and documented but never filled, so every caller had to re-read the body for it.
- Updated dependencies [4964eb8]
- Updated dependencies [3ed9e9d]
- Updated dependencies [7418e7e]
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
