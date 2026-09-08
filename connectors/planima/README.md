# @substrat-run/connector-planima

The Substrat connector for [Planima](https://planima.se/) — Swedish planned facility
maintenance (*underhållsplan*). Reads a maintenance plan on a poll and lands it into a
scope through the consuming vertical's own operation.

Full documentation: **[substrat.net/connectors/planima](https://substrat.net/connectors/planima)**.

> **Not yet verified against a live account.** Every claim here comes from Planima's
> published [OpenAPI document](https://developer.planima.se/) and is held up by a mock
> that encodes the same reading — so mock and client can agree with each other while both
> disagree with Planima. `test/live.test.ts` is written and skips until `PLANIMA_TOKEN` is
> present.

## What it is

- **Poll-only.** No event handler, no dispatch. Nothing inside a scope initiates this —
  the plan changes in Planima and the platform finds out by looking.
- **Read-only.** Every call is a `GET`. Planima's write endpoints exist and are not used.
- **Host code**, never module code: it is swept on a `ScopeHost`, and module code cannot
  reach `fetch` at all.

## Using it

```ts
import { bindPlanimaScope, sweepPlanimaPlan } from '@substrat-run/connector-planima';
import { globalFetch } from '@substrat-run/kernel';

// Once, per scope. Refuses if the connection does not hold the permission.
await bindPlanimaScope(host, {
  connectionId,
  tenantId,
  scopeId,
  vertical: 'maintenance',
  operation: 'maintenance/record-plan', // YOUR operation
  permission: 'plan:record',            // which it checks
  organizationId: null,                 // or one id
  currency: 'SEK',
  horizonYears: 10,
});

// On a timer, from the platform sweeper.
await sweepPlanimaPlan(host, connectionId, { fetch: globalFetch });
```

Your landing operation receives a `PlanimaPlanPage`. Pages are global across one sync and
each names one facility: buildings and components ride the facility's first page
(`facilityHead`), actions ride every page 500 at a time, and `final` marks the last page of
the sync. Every page of one sync carries the same `syncId`, so an upsert keyed on it is
idempotent.

## The credential

One static API token, created in Planima under *account settings → API*.

**Mint it as a read-only user.** A Planima token carries the full access of whoever created
it and there are no scopes to narrow it — so choosing the user is the only control there
is, and this connector never writes.

## Development

```sh
pnpm --filter @substrat-run/connector-planima test       # against the in-memory mock
```

The live suite runs when a token is present, in `secrets/connectors.env` at the repo root
(canonical, shared by every connector), this package's `.dev.vars`, or `PLANIMA_TOKEN` in
the environment. See [`.dev.vars.example`](./.dev.vars.example).

```sh
PLANIMA_TOKEN=… pnpm --filter @substrat-run/connector-planima test
```

It is read-only and creates nothing, so it is safe against a real account — but it does
spend requests against a 10-per-10-second budget.
