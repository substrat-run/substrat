# Your own connector

When the provider your app needs is not in the [list](/connectors/#available-connectors), your
app can define the connector itself and ship it with `substrat push`. Nothing has to change on the
platform. The platform still keeps the credential, the bindings, the connector's state and the
sweep schedule. It runs your provider code **in your app's own worker**, and hands it one
connection at a time.

::: warning Proposed
This rests on [D-64](https://github.com/substrat-run/substrat/blob/main/docs/decisions/D-064-a-vertical-may-define-its-own-connector-and-it-runs-in-the-vertical-s-worker.md),
which is awaiting ratification. The design is
[vertical-connectors.md](https://github.com/substrat-run/substrat/blob/main/docs/architecture/vertical-connectors.md).
:::

## At a glance

| | |
|---|---|
| **Name** | `<namespace>.<name>`, e.g. `acme.docbox`. The dot is what marks it as yours; a platform connector's name never has one |
| **Where it runs** | your worker, called by the platform through the router |
| **What it can reach** | on each call, the hosts your app declares in `substrat.outbound` |
| **What it can write** | what its connection is granted, through your app's own operations |
| **Credential** | entered by the tenant into the form your declaration describes; stored sealed by the platform, and handed to your connector's code on each call |
| **Not yet** | OAuth consent rounds, webhooks, sending mail, listing it for other apps |

## Defining it

Put the connector in its own entry module. It is host code, not module code, so it may call
`fetch` — through the context it is handed — and it must not be imported by your modules.

```ts
// src/connectors.ts
import { defineConnectors } from '@substrat-run/vertical-host/connectors';
import { ConnectorRefusal } from '@substrat-run/kernel';

export const connectors = defineConnectors({
  'acme.docbox': {
    label: 'DocBox',
    description: 'The document box an accounting firm shares with its client.',
    fields: [
      { key: 'company', label: 'Company code', secret: false },
      { key: 'user', label: 'User', secret: false },
      { key: 'password', label: 'Password', secret: true },
    ],
    grants: [],                          // standing grants the connection holds
    async probeCandidate(secret, { fetch }) {
      const ok = await signIn(fetch, secret);
      return ok ? { ok: true, accountLabel: secret.company } : { ok: false, refused: true, error: 'sign-in refused' };
    },
    async probe(ctx) {
      return (await signIn(ctx.fetch, ctx.secret)) ? { ok: true } : { ok: false, refused: true };
    },
    async sweep(ctx) {
      const since = (await ctx.state.get('cursor')) as string | undefined;
      const docs = await listNewerThan(ctx.fetch, ctx.secret, since);
      for (const doc of docs) await ctx.land(doc);          // your landing operation, as the connection
      if (docs.length) await ctx.state.put('cursor', docs.at(-1)!.modifiedAt);
      return { landed: docs.length };
    },
  },
});
```

Name the module in `package.json`, and mount the same value in your worker:

```json
{ "substrat": { "connectors": "src/connectors.ts", "outbound": ["api.docbox.example"] } }
```

```ts
// src/worker.ts
import { connectors } from './connectors.js';

mountPlatformSurface(app, { /* … */ connectors });
```

`probe` and `probeCandidate` are required, as they are for every connector: a connection a tenant
cannot test is a button that fails. A probe may answer `{ ok: true }` alone.

## Declaring where it lands

A sweep writes by invoking one operation your module declares, holding one key — the same
declaration a platform connector uses:

```ts
connections: [{ provider: 'acme.docbox', operation: 'docs/land', permission: 'docs:land' }]
```

After a tenant connects, the platform's next connector pass grants that key to the connection on
each of the app's scopes and binds it there. Every sweep is then **one call per bound scope**, sent to the
deployment that scope runs, and `ctx.land(input)` invokes `docs/land` there as the connection.

## Routing events to it

To act on something your app emits — a document a user asked to file with the provider — route the
event type to `dispatch` and register it on your scope host:

```ts
'acme.docbox': {
  // …
  events: ['docs.files-requested'],
  async dispatch(ctx, event) { /* upload, then ctx.state.put(...) to remember it */ },
}
```

```ts
declareConnectorEvents(host, connectors);   // beside host.registerModule(...)
```

The event becomes a platform request; the platform opens the connection and calls `dispatch` with
it. Delivery is **at least once**, so key what you do on the event id.

## What the context gives you

| | |
|---|---|
| `ctx.secret` | the fields the tenant entered, for this connection |
| `ctx.fetch` | bounded by a deadline, and every call is recorded on the connection's health |
| `ctx.state` | `get` / `put` / `list`, kept by the platform between calls; `put(key, null)` deletes |
| `ctx.scope` | on a sweep, bind or dispatch: the scope, and the binding's operation and options |
| `ctx.land(input)` / `ctx.invoke(op, input)` | run an operation in that scope as the connection; its grants decide |
| `ctx.attachments` | `upload` and `open`, as the connection |

State comes in with each call and goes back with the answer. It is written **only when the call
succeeds**, so a cursor never moves past work that did not land. It is capped at 512 KiB and 2,000
keys per call — a document box of a few hundred items fits; a whole drive does not.

Throw `ConnectorRefusal` for a failure retrying cannot fix (a revoked password): a dispatch then
fails for good and a probe answers `refused`. Any other throw is retried.

## Push checks

`substrat push` refuses a connector that:

- has no dot in its name, or is defined twice;
- holds a standing grant your app does not declare, or one an engine reserves to the system;
- routes an event no module of your app emits.

A tenant can connect a provider only once the version your app **serves** declares it, and the
connection's standing grants are that version's — a push that widens them takes effect when it is
promoted, not before. A connection stays listed and revocable on the dashboard even after a later
version stops declaring its provider.

A connector's standing grants are part of your app's permission registry, so changing them moves
the permission digest a promotion asks you to acknowledge.

## Sharing it

A connector is a value, so it can live in its own npm package and several apps can import it. Each
app runs its own copy under its own `outbound` and grants, and its tenants' connections stay apart.
Listing a connector so that apps you do not own can bind it is not available yet.
