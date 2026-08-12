# @substrat-run/engine-test-kit

Kernel-backed fixture for testing [Substrat](https://github.com/substrat-run/substrat) engines
directly — a real scope host, a real permission checker, and an event probe to drive consumers.

**Internal to this monorepo — not published to npm.** Engines depend on it as a dev dependency.

Background on what it is fixturing: **https://substrat.net/engines**

```ts
import { engineHarness } from '@substrat-run/engine-test-kit';

const h = await engineHarness({ /* modules, roles, principal … */ });
```

`EngineHarness` hands back the scope stub to invoke through, the emitted-event log
(`EmittedEvent`) for driving consumers, and the `DeadLetter` list for what a consumer refused.

## Why a real host

Engines own invariants, and an invariant only means something against the machinery that
enforces it. This kit runs each engine against an actual `SqliteScopeHost` with a real
permission checker rather than a mock, so a test that passes is evidence the operation checks
its permission, emits its event, and holds its state machine under the same rules production
uses.

The event probe captures what the engine emitted, which is how a consumer is driven: engines
never import each other, so cooperation is tested through
[fat event payloads](https://substrat.net/concepts/events), exactly as it happens at runtime.

## Node-only, by design

It imports `node:fs`, `node:os`, `node:path`, and `better-sqlite3` to stand up a temporary
database per fixture. That is legal because it is **harness code** — the
[module-code rules](https://substrat.net/concepts/modules) that ban `node:*` apply to
everything reachable from a `ModuleRegistration`, not to the tests driving it.

## Related

- [`@substrat-run/adapter-sqlite`](https://npmjs.com/package/@substrat-run/adapter-sqlite) —
  the host it runs engines against
- [`@substrat-run/contract-tests`](https://npmjs.com/package/@substrat-run/contract-tests) —
  the suites every *adapter* must pass (the layer below this one)
