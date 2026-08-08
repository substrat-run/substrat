# @substrat-run/vertical-host

## 0.54.0

### Patch Changes

- a16a3d4: fix(vertical-host,control-plane): a platform fault answers 502, and the control plane keeps its own logs (#559)

  The `/internal/*` error envelope defaulted every unrecognized throw to 400 — so a
  Cloudflare DO SQLite storage fault (`internal error; reference = <id>`) crossed the
  control plane's verbatim passthrough and reached CI dressed as "you sent a bad
  request", unresolvable by anyone but Cloudflare support and invisible to every
  retry convention that (correctly) refuses to retry a 4xx. The envelope now
  recognizes infrastructure-fault shapes — workerd's `retryable`/`overloaded` flags,
  the redacted DO SQLite message, DO resets — answers 502 with the message intact,
  and logs `vertical-host.platform-fault` structured so the vertical's observability
  keeps stage + reference queryable. App errors that merely mention "internal error"
  mid-sentence stay 400; explicit HTTPException statuses stay authoritative.

  The control-plane worker also gains `observability: enabled` (prod and env.test):
  its own `deploy.upload.failed` / `control-plane.unhandled` diagnostics previously
  existed only in a live `wrangler tail`.

- Updated dependencies [b387919]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0

## 0.53.0

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0

## 0.52.0

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.51.0

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0

## 0.50.0

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0

## 0.49.0

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.48.1

### Patch Changes

- @substrat-run/contracts@0.48.1
- @substrat-run/kernel@0.48.1

## 0.48.0

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0

## 0.47.0

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/contracts@0.47.0

## 0.46.0

### Minor Changes

- 54d3d0e: Add `@substrat-run/vertical-host` — the platform's `/internal/*` management contract
  (provision, reconcile, introspection, the read-only SQL console, platform-request drain,
  snapshot/delete/export/restore, bookmarks/rewind, configure) plus the guaranteed `{ error }`
  response envelope, authored once and mounted with `mountPlatformSurface(app, deps)`.

  Verticals no longer hand-copy these routes and a Hono `onError` into their own `worker.ts` —
  copies that had already drifted (route sets disagreed; some workers shipped without the error
  handler, so a failing `/internal/restore` reached the control plane as the runtime's bare
  `Internal Server Error` with no diagnosis, issue #510). Meridian, Manyfold and the
  `create-substrat` template now mount the shared surface; a repo-wide `hono` override pins a
  single version so the mounted `Hono` app type matches its consumers.

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0
