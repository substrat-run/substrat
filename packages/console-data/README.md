# @substrat-run/console-data

The data-source contract the console's views read from, and its **local** implementation
(#2360). A view (request list, waterfall, process map, permissions) is written once against
`ConsoleDataSource`. Where the data comes from is the source's business: the working tree
under `substrat dev`, the hosted request record, or an external tool.

Pure TypeScript: no React, no Cloudflare, no `node:*`. It runs in a browser, a worker and the
dev server alike. Private for now; see [the architecture note](../../docs/architecture/console-data-source.md)
for why it sits apart from the console and the dashboard.

## The contract

```ts
interface ConsoleDataSource {
  describe(): SourceDescription;                 // id, kind, label, capabilities
  artifacts(): Promise<SourceArtifacts>;         // model.json (entities, lifecycles), permissions
  queryRequests(q: RequestQuery): Promise<RequestPage>;  // newest first, keyset-paged
  facets(q: RequestQuery): Promise<RequestFacets>;       // counts, own key left out
  getTrace(invocationId: string): Promise<RequestTrace | null>;
  tail?(q, listener): () => void;                // only when capabilities.tail
}
```

- **Query-first, never tail-first.** Every read is a window (`from`/`to`, epoch ms, on
  `startedAt`) plus facet filters. A hosted record can answer a window; it cannot stream. So
  tailing is an optional extra, and a view that tails must still draw from a query alone.
- **The shapes are the contracts' own.** A request is a `TraceHead`, the head of the hosted
  invocation line (#1746), under the same field names. A trace is a `RequestTrace` (#2358).
  Neither is redefined here.
- **Facet filters read the hosted way.** Values under one key are OR, keys are AND, and each
  key is counted with its own filter left out. The keys are the hosted request facets that
  live in the head: `level`, `operation`, `principalKind`, `problemCode`, `surface`, `status`.

## Capabilities: degrade, never lie

Each source declares what it can answer:

| Capability | Meaning when declared | Off |
| --- | --- | --- |
| `tail` | `tail()` exists and delivers new requests | refresh to see more |
| `rawPayloads` | SQL steps may carry bound values | no read returns one |
| `exactFacetCounts` | counts are exact, `estimated` is never true | counts may be estimates, flagged |
| `traceSteps` | `getTrace` returns the steps inside a call | heads only, `steps: []` |
| `model` | `artifacts().model` is the vertical's model | `null` |
| `permissions` | `artifacts().permissions` is its roles and keys | `null` |
| `requestFields` | the head fields it fills | the rest are `null` / `[]` |

A view looks up its needs in `VIEW_NEEDS` and calls `negotiate(capabilities, needs)`. The
result says whether the view is available, what it lost, and which shown fields the source
never fills. `MISSING_CAPABILITY_TEXT` gives the sentence to show in each case. The answer
to "why is this empty" names the source, not the app.

## The local source

```ts
import { createLocalSource } from '@substrat-run/console-data';

const source = createLocalSource({
  label: 'demos/todo',
  artifacts: async () => ({
    modelJson: JSON.parse(await readFile('model.json', 'utf8')),
    permissionsMd: await readFile('PERMISSIONS.md', 'utf8'),
  }),
  traces: traceBuffer, // any TraceReader: { traces(), subscribe?() }
});
```

It reads nothing itself. The caller reads the artifacts on each call, so an edit in the
working tree shows on the next read, and passes a `TraceReader` over the local trace buffer.
`TraceReader` is an interface, so #2358's buffer plugs in without this package depending on
it. Everything crossing in is parsed: the model by `emittedModel`, each trace by
`requestTrace`. A record that does not parse is left out.

Bound SQL values are **stripped by default** (`capture.sqlParams: false`), because a bound
value is as likely to be a person's data as an id, and a trace may be read into a model's
context. Pass `rawPayloads: true` to keep what the recorder kept.

## The contract suite

Every source, hosted and external included, passes the same suite:

```ts
import { describe, it } from 'vitest';
import { registerContract } from '@substrat-run/console-data';

registerContract('hosted source', {
  async create(world) {
    // load world.traces / world.modelJson / world.permissionsMd into the source's store
    return { source, record: (trace) => store.add(trace) };
  },
}, { describe, it });
```

Each check has a stable name (`CONTRACT_CHECKS`). Each declared capability is held by one
check, so a source that claims what it cannot do fails a named check, and a source that
declares less passes with less. `test/fixtures.ts` holds the proof that the suite bites:
an honest head-only source in the hosted shape passes, and a set of liars each fail exactly
the one check named for their lie.
