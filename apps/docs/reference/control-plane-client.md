# @substrat-run/control-plane-client

The typed HTTP client for the [control-plane API](/reference/control-plane-api). It is the
one place a caller learns how a request to the plane is authenticated, how a refusal is
read, and what an empty answer means — so the CLI, the staff console, the dashboard and a
vertical's connect seam do not each restate it.

```sh
pnpm add @substrat-run/control-plane-client
```

## Using it

```ts
import { ControlPlaneClient, ControlPlaneError } from '@substrat-run/control-plane-client';

const plane = new ControlPlaneClient({
  baseUrl: 'https://console.substrat.net/api',
  actor: '<platform actor id>', // sent only when no serviceToken is set
  serviceToken: process.env.SERVICE_TOKEN,
});

try {
  await plane.assertScopeActive(tenantId, scopeId);
} catch (e) {
  if (e instanceof ControlPlaneError) console.error(e.status, e.message);
}
```

A non-2xx answer or an unreachable plane throws `ControlPlaneError`: `status` is the HTTP
status (`0` when no response arrived) and `message` the problem document's `detail`, else
the status line. `fetch` is injectable, so a Worker service binding or an in-process
`app.fetch` stands in for the network.

## The builder surface

`ControlPlaneBuilderClient` is the typed surface a builder's own tooling calls — the one the
[CLI](/reference/cli) is built on: who am I (`whoami`), a vertical's versions and channels,
`promoteChannel`, listing, hostnames, and the scope tools. Its methods return the fields a
tool reads, typed and not parsed, and a refusal is a `ControlPlaneError` carrying the raw
`body`, `statusText` and response `headers`, so a caller that renders its own messages keeps
them. `walkPages` follows a list's cursor to the end.

```ts
import { ControlPlaneBuilderClient, walkPages } from '@substrat-run/control-plane-client';

const plane = new ControlPlaneBuilderClient({
  baseUrl: 'https://console.substrat.net/api',
  actor: null,
  headers: { authorization: `Bearer ${token}` }, // the credential map you already hold
});
const versions = await walkPages((page) => plane.listVersions('acme/crm', page));
```

`headers` sits beneath the transport's own credential (`serviceToken`, `actor`) and the
request's own headers, never above them; `request()` gives back the raw `Response` for a caller
that owns its own retry or upload; `fetch` is read from `globalThis` at call time.

## Why it is its own package

The server, [`@substrat-run/control-plane-api`](/reference/control-plane-api), is AGPL-3.0:
it is served over a network, which is what AGPL §13 is about. The client is what a
builder's own tooling imports, and tooling must not copyleft-capture the code it runs
against — the same reason [`contracts`](/reference/contracts) and the CLI are Apache-2.0.
So the client is Apache-2.0 and reaches nothing but `fetch` and `contracts`; the server
package re-exports it, so an existing import keeps working.
