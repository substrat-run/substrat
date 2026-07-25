# @substrat-run/kernel

Kernel contracts and services for [Substrat](https://github.com/substrat-run/substrat) —
the hard parts of vertical B2B SaaS (tenancy, permissions, audit, GDPR), hosted and
enforced at runtime.

This package defines the **behavioral seams** of the kernel in pure TypeScript. It
imports no platform APIs — Cloudflare specifics live only in adapters, and every
adapter must pass the same conformance suite
([`@substrat-run/contract-tests`](https://npmjs.com/package/@substrat-run/contract-tests)).

**Full documentation: https://substrat.net/reference/kernel**

## The scope-host contract

A *scope* is one isolation domain (a BRF, a filial, a brand) with its own SQLite
database. Module code registers **operations**; callers reach a scope only through a
capability stub minted by the host:

```ts
import type { ScopeHost } from '@substrat-run/kernel';

host.defineOperation('workorder/create', async (ctx, input) => {
  await ctx.check('workorder:create');      // ambient principal + scope
  ctx.sql.exec('INSERT INTO work_orders ...');
  ctx.emit({ type: 'workorder.created', ... }); // envelope stamped kernel-side
});

const stub = await host.getScope(principal, tenantId, scopeId); // fails closed on mismatch
await stub.invoke('workorder/create', input);
```

Handlers run *inside* the scope's execution domain (a Durable Object in production, a
per-scope actor locally) — one network hop, then local queries.

## Contract semantics (what adapters must guarantee)

- **Strict serialization per scope** — one operation at a time, to completion.
- **Structured-clone boundary** — inputs and results are cloned even in-process; code
  can never share mutable state with a scope.
- **Kernel-stamped events** — id, timestamp, tenant, scope, and actor are stamped below
  the API surface; callers cannot mislabel an event's origin.
- **Fail-closed addressing** — a mismatched `(tenantId, scopeId)` pair throws; it never
  resolves to another tenant's scope.

Also exported: the `PermissionChecker` seam (with a secure-default `denyAllChecker` and
a deliberately alarming `UNSAFE_allowAllChecker` for tests) and a dependency-free
`ulid()`.

## Related packages

- [`@substrat-run/contracts`](https://npmjs.com/package/@substrat-run/contracts) — the Zod data
  shapes these interfaces are built on
- [`@substrat-run/adapter-sqlite`](https://npmjs.com/package/@substrat-run/adapter-sqlite) — the
  pure-SQLite reference implementation

## Status

Pre-release (0.x): interfaces change without notice until the first vertical ships.
