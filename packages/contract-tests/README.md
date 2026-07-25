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

## Status

Pre-release (0.x): the suite expands as kernel contracts land.
