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
  scopes.
- `sweepBolagsverket`: a no-op. Nothing is bound to a connection in v1.

There is no dispatch yet, so a vertical cannot ask for a validation through the platform.
That is the next step. The control plane uses production unless `BOLAGSVERKET_ENV=test`;
`BOLAGSVERKET_TOKEN_URL` and `BOLAGSVERKET_API_BASE` override the hosts.

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
