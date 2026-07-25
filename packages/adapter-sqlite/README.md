# @substrat-run/adapter-sqlite

Pure-SQLite scope host for [Substrat](https://github.com/substrat-run/substrat) — real
kernel semantics with **no Cloudflare dependency**.

One SQLite file per scope, a per-scope actor for strict serialization, a directory
database for fail-closed scope addressing, and a kernel-stamped event outbox. It is not
a mock: it is the adapter that local development and CI run on, and the reason the
self-host/escrow story is literally true (single-node, but runnable).

**Full documentation: https://substrat.net/reference/adapter-sqlite**

## Usage

```ts
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { UNSAFE_allowAllChecker } from '@substrat-run/kernel';

const host = new SqliteScopeHost({
  dir: './data',                    // one .sqlite file per scope + _directory.sqlite
  checker: UNSAFE_allowAllChecker,  // omit for the secure default: deny everything
});

await host.provisionScope({ tenantId, scopeId, jurisdiction: 'eu' }); // idempotent
const stub = await host.getScope(principal, tenantId, scopeId);
await stub.invoke('workorder/create', input);
await host.close();
```

## Guarantees

This adapter passes the full
[`@substrat-run/contract-tests`](https://npmjs.com/package/@substrat-run/contract-tests) suite —
the same suite the Cloudflare adapter (Durable Objects) must pass unchanged:

- strict per-scope serialization (concurrent read-modify-writes cannot interleave)
- structured-clone boundary on every stub call, both directions
- kernel-stamped event envelopes; PII-classed events without a `subjectId` are rejected
- scope storage isolation; mismatched `(tenantId, scopeId)` pairs fail closed

## Notes

- Uses [better-sqlite3](https://npmjs.com/package/better-sqlite3) (native module). With
  pnpm 10+, allow its build script via `pnpm.onlyBuiltDependencies`.
- Scope databases run in WAL mode and can be opened read-only with any SQLite tool —
  local debugging is just opening a file.

## Status

Pre-release (0.x). Migration journal, attachments, and the outbox drain are still
landing.
