# @substrat-run/contract-tests

The conformance suite for [Substrat](https://github.com/substrat-run/substrat)
scope-host adapters. Every adapter — pure SQLite, Cloudflare Durable Objects, and any
future one — must pass this suite **unchanged**, forever. If an adapter needs the suite
modified, the contract changed, and that is a decision, not a patch.

This package exports test *suites* (built on [Vitest](https://vitest.dev)); it runs
nothing itself. Each adapter runs the suite from its own `test/` folder.

**Full documentation: https://substrat.net/reference/contract-tests**

## Usage

```ts
// packages/adapter-yours/test/contract.test.ts
import { scopeHostContractSuite } from '@substrat-run/contract-tests';
import { YourScopeHost } from '../src/index.js';

scopeHostContractSuite('adapter-yours', async () => {
  const host = new YourScopeHost({ ... });
  return {
    host,
    cleanup: async () => host.close(),
  };
});
```

## What the suite verifies

- **Strict serialization per scope** — 10 concurrent read-await-write increments must
  land on exactly 10.
- **Structured-clone boundary** — mutating an input after `invoke()`, or a returned
  result, must never affect scope state.
- **Kernel-stamped envelopes** — tenant, scope, ULID id, and timestamp are stamped
  below the API surface.
- **PII classification enforced** — a PII-classed event without a `subjectId` is
  rejected at emit.
- **Isolation and fail-closed addressing** — writes in one scope are invisible in
  another; a mismatched `(tenantId, scopeId)` pair throws.

The suite grows with the kernel (migration journal, crash-mid-migration,
duplicate-delivery harnesses); adapters inherit new checks by upgrading.

## Suites gated by mounting, not by a flag

Most suites take a `ScopeHostFixture` and every adapter mounts every one. A few need
something only some hosts can provide, and those are separate exports an adapter
mounts only when it can satisfy the fixture. There is deliberately no capability flag
that makes a shared suite skip on one adapter: a skipped test reads as coverage the
adapter does not have.

- **`grantExpiryContractSuite`** — the fixture returns `{ host, clock, cleanup }` where
  `clock` is the `ManualClock` (from `@substrat-run/kernel`) the host was constructed
  with. The suite grants a permission with an `expiresAt` an hour ahead, asserts it is
  live, moves the clock past it and asserts the denial — the transition the wall clock
  cannot show in a test. Mounted by `adapter-sqlite` (`new SqliteScopeHost({ dir,
  clock: clock.read })`).

  **Parity gap, stated:** `adapter-cloudflare` does not mount it. The Durable Object
  reads the wall clock inside the DO, which workerd constructs — an option on
  `CloudflareScopeHost` never reaches it, because the host only holds a stub. Getting a
  clock there is a decision (caller-supplied `now` per invocation, a test-only seam, or
  neither), tracked on #956. Until one is taken, the DO's checker runs the same
  `expires_at` predicate against a `now` it reads itself, and the pure host is the one
  held to the contract by this suite.

## Status

Pre-release (0.x): the suite expands as kernel contracts land.
