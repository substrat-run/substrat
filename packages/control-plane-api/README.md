# @substrat-run/control-plane-api

The HTTP surface over `HostAdmin` for [Substrat](https://github.com/substrat-run/substrat) —
the **audited control-plane transport**. It is the seam between the platform's admin
operations (provision a scope, bind a hostname, grant a role, deploy a vertical) and
whatever runs them: the console, the CLI, or another service.

It is a transport, not a source of truth. Every call lands on `HostAdmin`, every mutation
is audited, and the same contract runs over any scope host (the pure-SQLite adapter in
CI, Durable Objects in production).

## What's in the box

- **`createControlPlaneApi`** — a [Hono](https://hono.dev) app exposing `HostAdmin` over
  HTTP, with authentication and the audit log wired in.
- **`ControlPlaneClient`** — the typed client for that surface (what the console and CLI
  call), plus `ControlPlaneError` for structured failures.
- **`VerticalClient`** — the narrowed, tenant-scoped seam an app uses to provision itself.
- **`deployManifest` / `createWfpUploader`** — the deploy path: validate a vertical
  bundle against the sandbox contract and upload it to Workers-for-Platforms.

## Install

```sh
pnpm add @substrat-run/control-plane-api
```

```ts
import { createControlPlaneApi } from '@substrat-run/control-plane-api';

const app = createControlPlaneApi({ admin /* HostAdmin */, /* auth, audit, … */ });
export default app; // a Hono app — serve it on Node, Workers, or in tests
```

```ts
import { ControlPlaneClient } from '@substrat-run/control-plane-api';

const cp = new ControlPlaneClient({ baseUrl, token });
await cp.provisionScope({ tenant, slug });
```

## Documentation

**https://substrat.net/platform/control-plane** — the admin surface, the audit model,
authentication, and how the console/CLI/router sit on top of it.

## Related packages

- [`@substrat-run/kernel`](https://npmjs.com/package/@substrat-run/kernel) — the
  scope-host + `HostAdmin` contract this exposes
- [`@substrat-run/adapter-sqlite`](https://npmjs.com/package/@substrat-run/adapter-sqlite) —
  the pure-SQLite host it runs against in CI and self-host
- [`@substrat-run/cli`](https://npmjs.com/package/@substrat-run/cli) — the deploy tooling
  that drives this surface

## Status

Pre-release (0.x): the surface changes without notice until the platform GAs.
