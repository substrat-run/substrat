# @substrat-run/connector-bolagsverket

The Substrat connector for [Bolagsverket](https://bolagsverket.se/), the Swedish Companies
Registration Office. It validates a Swedish organisation number through Bolagsverket's free
[API för värdefulla datamängder](https://bolagsverket.se/apierochoppnadata/hamtaforetagsinformation/vardefulladatamangder/apiforvardefulladatamangder.5513.html)
(the EU high-value datasets API). It answers whether the number names a registered
organisation, and if so its name, legal form, postal address, SNI codes, registration date,
and whether it is active, deregistered, in liquidation, bankrupt or in reorganisation.

> **Private, and not yet verified against Bolagsverket.** No credential has been issued
> yet. The URLs and the response shape come from community client libraries, not from a
> recording or from Bolagsverket's own OpenAPI document. The fixture suite holds the
> client to that reading. `test/live.test.ts` is written and skips until the credential
> keys below are present, and it is what checks the reading against the real API.

## In the platform

The credential is the **tenant's own**. A tenant applies to Bolagsverket, then pastes the
client id and secret into the dashboard's Bolagsverket door. The pair is sealed in a
per-tenant connection, so the provider's 60-a-minute limit is metered per tenant. The
control plane registers:

- `probeBolagsverketSecret`: checks a pasted pair before it is stored, by minting a token
  and pinging.
- `probeBolagsverketConnection`: does the same for a stored pair, and records the use. A
  client credential names no account, so both report the environment and the granted
  scopes. A client granted the ping scope but not `vardefulla-datamangder:read` fails the
  probe, since it would fail every lookup.
- `bolagsverketConnector`: the dispatch. It looks a number up and lands the answer in the
  scope that asked (below).
- `bindBolagsverketScope`, `listBolagsverketBindings`, `unbindBolagsverketScope`: where a
  scope's answers land. The platform's connector pass calls them from the vertical's
  declaration.
- `sweepBolagsverket`: a no-op. A binding only says where answers land, and the dispatch
  lands them, so there is nothing to re-read.

The control plane uses production unless `BOLAGSVERKET_ENV=test`; `BOLAGSVERKET_TOKEN_URL`
and `BOLAGSVERKET_API_BASE` override the hosts.

### Looking a number up from a vertical

A vertical asks for a lookup by emitting an event, and gets the answer as a call to one of
its own operations, made as the connection. Three pieces, all in the vertical:

1. **Ask.** An operation emits `bolagsverket.organisation-lookup-requested`
   (`BOLAGSVERKET_LOOKUP_REQUESTED`) with a payload `bolagsverketLookupRequested` parses:
   the vertical's own `requestId`, the `organisationNumber`, and optionally the `subject`
   (an `EntityRef`, such as the customer the number belongs to), which comes back unchanged.
   Check the number with `parseOrgnr` first: a personnummer is refused and never sent to
   Bolagsverket, but the event that carried it is already in the scope's outbox.

   ```ts
   ctx.emit({
     type: BOLAGSVERKET_LOOKUP_REQUESTED,
     schemaVersion: 1,
     entity: { entityType: 'customer', entityId: customerId },
     piiClass: 'none',
     payload: { requestId, organisationNumber, subject: { entityType: 'customer', entityId: customerId } },
   });
   ```

2. **Say where the answer lands.** The module manifest declares a connection landing:

   ```ts
   connections: [{ provider: 'bolagsverket', operation: 'crm/record-organisation-lookup', permission: 'crm:organisation-lookup:record' }],
   ```

   The platform's connector pass grants that key to each live Bolagsverket connection and
   binds it to every primary, active install. The operation receives a
   `bolagsverketLookupLanding`: `requestId`, `subject`, `connectionId`, `checkedAt`, an
   `outcome` of `found`, `not_found`, `invalid` (with `reason` `format`, `checksum` or
   `personnummer`) or `refused` (Bolagsverket turned the tenant's client away), and the
   `result` for `found` and `not_found`. It should upsert on `requestId`: delivery is at
   least once.

3. **Route the event.** The vertical's scope host registers it for routing only, so a
   delivery becomes a `connector:bolagsverket` platform intent:
   `declareBolagsverketConnector(host)`, beside `declareScriveConnector(host)` if it has one.

The router kicks the platform's drain as soon as the request commits, so the answer usually
lands within seconds. A rate limit or an outage lands nothing and is retried by the drain. A
lookup that arrives before the connector pass has bound the scope waits for it too (the pass
runs every 15 minutes). There is no caching yet: every request is a call to Bolagsverket.

### As its own script (pilot)

The package also ships a Worker entry, `src/script.ts`, that serves the connector's probes over the
platform's connector call contract, deployed by `wrangler.jsonc` into the dispatch namespace as
`substrat-connector-bolagsverket`. The control plane calls it through the router only when
`REMOTE_CONNECTORS` names `bolagsverket`, which no environment does; otherwise everything above runs
in-process as before. The lookup dispatch always runs in-process. It declares no binding: the credential and the configuration arrive in each call.
See [docs/rfc/connector-scripts.md](../../docs/rfc/connector-scripts.md), phase 1.

## What it is

- **One lookup.** `POST /organisationer` by organisation number, plus `GET /isalive` for
  health. Lookup by name is not offered by this API. Board members, signatories and
  annual reports are out of scope.
- **Legal entities only.** A sole trader's organisation number is their personnummer.
  v1 refuses one locally, so a person's identity number is never sent or stored.
- **Host code**, never module code. It calls out through the `fetch` it is handed (a
  connection's egress in the platform, `globalFetch` from `@substrat-run/kernel` locally),
  never through the bare global.

## Using it

```ts
import { BolagsverketApi, BolagsverketError } from '@substrat-run/connector-bolagsverket';
import { globalFetch } from '@substrat-run/kernel';

const api = new BolagsverketApi({ clientId, clientSecret }, globalFetch, { environment: 'test' });

try {
  const result = await api.validateOrganisation('556000-0001');
  if (result.exists) console.log(result.name, result.status);
} catch (err) {
  if (err instanceof BolagsverketError && err.code === 'invalid_orgnr') {
    // refused locally: err.reason is 'format' | 'checksum' | 'personnummer'
  }
}
```

### The number

Accepted: `NNNNNN-NNNN`, ten bare digits, or twelve digits with the `16` prefix, any of them
with surrounding whitespace. The check digit is verified with Luhn. A number that fails the
check, or is a personnummer, throws `invalid_orgnr` before any request is made, not even
the token request.

### The result

```ts
| {
    exists: true;
    orgnr: string;                  // canonical: ten digits, no dash
    name: string | null;            // the registered company name
    legalForm: { code: string; label: string | null } | null;
    status: 'active' | 'deregistered' | 'liquidation' | 'bankruptcy' | 'reorganisation' | 'other';
    statusDetail: string | null;    // the register's own text for the status
    address: { street; postalCode; city; country } | null;
    sni: { code: string; label: string | null }[];
    registeredAt: string | null;    // ISO date
    source: { provider: 'bolagsverket'; environment: 'prod' | 'test' };
    fetchedAt: string;              // ISO timestamp of the lookup
  }
| { exists: false; orgnr; source; fetchedAt }
```

A number the register has no entry for is `exists: false`. That is an answer, not an error.
There is no cache per organisation number. A status can change from one day to the next,
so `fetchedAt` lets the caller decide how fresh a validation has to be.

### Errors

`BolagsverketError.code` is one of:

| code | meaning |
|---|---|
| `invalid_orgnr` | refused locally, never sent; `reason` says why |
| `refused` | the client was turned away: a token mint with `invalid_client`, a 403, or a 401 that survives one re-mint |
| `rate_limited` | a 429 that outlasted the retries; `retryAfterSeconds` is the provider's wait |
| `upstream` | anything that says nothing about the credential: a 5xx, a timeout, a body that is not the expected shape |

### Rate limit

Bolagsverket allows 60 requests a minute per client. The client keeps a sliding window and
waits when the 61st request in a minute is due. On a 429 it waits as `Retry-After` says,
up to `maxRateLimitRetries` times (default 3; a probe passes 0). The limit is per
credential, so callers holding several clients on one credential pass one shared
`rateWindow` array to all of them.

### Environments

| `environment` | token URL | API base |
|---|---|---|
| `prod` (default) | `https://portal.api.bolagsverket.se/oauth2/token` | `https://gw.api.bolagsverket.se/vardefulla-datamangder/v1` |
| `test` | `https://portal-accept2.api.bolagsverket.se/oauth2/token` | `https://gw-accept2.api.bolagsverket.se/vardefulla-datamangder/v1` |

`tokenUrl` and `apiBase` override either one. The token is minted with the OAuth2 client
credentials grant (scopes `vardefulla-datamangder:read vardefulla-datamangder:ping`). It is
cached for the life of the client and minted again a minute before it expires.

## Getting a credential

There is no self-service sign-up. A maintainer submits Bolagsverket's
[kundanmälan](https://bolagsverket.se/apierochoppnadata/hamtaforetagsinformation/vardefulladatamangder/kundanmalantillapiforvardefulladatamangder.5528.html).
It needs a real email address (no noreply address) and a mobile number. Bolagsverket then
sends a client id and secret for both the test and the production environment. Expect days
rather than hours. Access is free and needs no agreement.

## Development

```sh
pnpm build   # once, so the workspace packages it imports have their dist
pnpm --filter @substrat-run/connector-bolagsverket test
```

The fixture suite (`test/api.test.ts`, `test/orgnr.test.ts`) runs offline on placeholder
data. To run the live suite against the test environment, put the pair in
`secrets/connectors.env` (gitignored, never pushed; see `secrets/connectors.env.example`):

```sh
BOLAGSVERKET_CLIENT_ID=…
BOLAGSVERKET_CLIENT_SECRET=…
# BOLAGSVERKET_ENV=prod              # default: test
# BOLAGSVERKET_TEST_ORGNR=…          # an entry that exists in that environment
```

When the live suite disagrees with the fixtures, correct `test/fixture.ts` and
`src/organisation.ts` from what it logs.
