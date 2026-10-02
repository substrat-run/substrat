# @substrat-run/control-plane-client

The typed HTTP client for the [control-plane API](/reference/control-plane-api). It is the
one place a caller learns how a request to the plane is authenticated, how a refusal is
read, and what an empty answer means — so the CLI, the staff console and a vertical's
connect seam do not each restate it.

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

## Why it is its own package

The server, [`@substrat-run/control-plane-api`](/reference/control-plane-api), is AGPL-3.0:
it is served over a network, which is what AGPL §13 is about. The client is what a
builder's own tooling imports, and tooling must not copyleft-capture the code it runs
against — the same reason [`contracts`](/reference/contracts) and the CLI are Apache-2.0.
So the client is Apache-2.0 and reaches nothing but `fetch` and `contracts`; the server
package re-exports it, so an existing import keeps working.
