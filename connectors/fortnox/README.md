# @substrat-run/connector-fortnox

Fortnox accounting for Substrat: reads a company's bookkeeping out of Fortnox as **SIE4**, parses
and sums it, and lands the result into a scope through the consuming vertical's own operation. A
**connector** is host code — you sweep it on a scope host; it is never module code.

**Full documentation: https://substrat.net/connectors/fortnox**

## What it does

One half, not two. `connector-scrive` has a dispatch handler *and* a poll; this connector has
**only the poll**, and that is a design fact rather than an omission. Nothing inside a scope
initiates this work: a vertical does not *ask* for last month's bookkeeping the way it asks for a
signature — the books simply change at Fortnox, and the platform finds out by looking.

So there is no `registerFortnoxConnector`. `sweepFortnoxLedger` is a `ConnectorSweeper`, the
deployment binds it into the platform sweeper exactly as it binds Scrive's, and that is the whole
trigger surface.

Each pass, per bound scope: mint a token → list financial years → pick the one that **overlaps**
the period → download SIE4 → hash it → parse, sum per (account, cost centre, month) → land it in
pages through the vertical's operation, as the connection itself ([#97](https://github.com/substrat-run/substrat/issues/97)).

## The credential: client credentials, not the authorization-code flow

This is the most important thing on this page, because it is the opposite of what most Fortnox
integration write-ups describe.

Fortnox's usual flow is OAuth2 authorization-code: a person signs in, you store an access token
and a **refresh token**, and you refresh forever. Fortnox's refresh tokens are **single-use and
rotating** — each refresh mints a new one and kills the old — so two concurrent refreshes race,
one wins, the other saves an already-dead token and the connection is bricked. Every integration
built that way ends up carrying the same three mitigations: per-company coalescing of concurrent
refreshes, optimistic locking on the token write, and a distinct "reconnect Fortnox" error.

**This connector does not have that problem, because it never holds a refresh token.** Fortnox
supports `grant_type=client_credentials` against a *service* consent, and a token minted that way
comes from three static values:

```ts
{ clientId, clientSecret, tenantId }   // tenantId = the company's numeric DatabaseNumber
```

An access token lives an hour and is minted on demand, cached for the life of one sweep pass.
There is no rotating state, so there is no rotation race, no coalescing map, no optimistic write,
and no token table. The connection's sealed secret is the whole credential.

The price is a **one-time consent round per company**, in a browser:

```ts
import { fortnoxConsentUrl } from '@substrat-run/connector-fortnox';

const url = fortnoxConsentUrl({
  clientId, redirectUri, state,
  scopes: ['bookkeeping', 'companyinformation'],
});
```

`account_type=service` is what makes the resulting consent mintable by client credentials
afterwards, and `fortnoxConsentUrl` always sets it. Your callback exchanges the code once, reads
`GET /3/companyinformation` for `DatabaseNumber`, and that number becomes the connection's
`tenantId`. After that the code path is never used again.

**To do that round once, locally**, from the repo root:

```text
pnpm fortnox:connect --client-id=<id> --client-secret=<secret>
```

Or paste the portal pair into `connectors/fortnox/.dev.vars` (gitignored) as
`FORTNOX_CLIENT_ID` / `FORTNOX_CLIENT_SECRET` and run `pnpm fortnox:connect` with no flags —
it reads that file for defaults, so a retry needs no arguments and no secret reaches shell
history. It prints the `FORTNOX_TENANT_ID` line to add, which is the one value that cannot be
typed by hand.

The redirect URI must match one registered in the portal exactly; the default is
`http://localhost:8899/callback`. Whether Fortnox accepts `http://` or `localhost` is not
documented — if it refuses, register a tunnel's https URL, pass it as `--redirect-uri`, and point
the tunnel at `--listen-port` (default 8899). The callback always speaks plain HTTP; terminating
TLS is the tunnel's job.

It serves the callback, completes the consent, reads the `DatabaseNumber`, then **mints again
with `client_credentials`** to prove the service consent actually works — and prints the three
lines for `connectors/fortnox/.dev.vars`. That last step is the point: it is this connector's
whole premise, and it fails loudly here rather than silently skipping a test. `DatabaseNumber` is
shown nowhere in the Developer Portal, so there is no way to assemble the credential by hand.

**Scopes cannot be widened without a new consent round.** Ask for what the integration will need,
not what it needs today — this is the single most expensive thing to get wrong, because fixing it
means going back to every customer.

### The hosted flow is the same code

A deployment that connects customers from a screen (the dashboard's Fortnox Connect button and
its shareable connect links, #1220) runs `completeFortnoxConsent` when the consent redirect comes
back: the code exchange, the `companyinformation` read, and the client-credentials proof are the
exported sequence, not a reimplementation of it. The caller supplies the code, the registered
redirect URI and a `fetch`; what comes back is the sealed-ready secret plus the company it names —
show that company to the person who clicked approve, because a consent granted while signed into
the wrong company-switcher entry looks identical up to that moment.

## Using it

```ts
import {
  bindFortnoxScope,
  sweepFortnoxLedger,
  probeFortnoxSecret,
} from '@substrat-run/connector-fortnox';

// 1. Check the credential BEFORE storing it (#605) — connecting should not mean
//    "write the row and find out on the next sweep".
const probe = await probeFortnoxSecret(secret, { fetch });
if (!probe.ok && probe.refused) throw new Error(probe.error!);

// 2. Open the connection with the client-credentials triple.
await host.admin.createConnection(actor, {
  id, tenantId, vertical, provider: 'fortnox', label,
  // String(): `DatabaseNumber` comes off the API as a number, and `fortnoxSecret`
  // wants a digit-only STRING (it is a header value, never arithmetic).
  secret: { clientId, clientSecret, tenantId: String(databaseNumber) },  // sealed by the SecretBox
});

// 3. Grant the connection the permission YOUR landing operation checks, then bind.
await host.admin.grantToConnection(actor, {
  connectionId: id, permission: 'ledger:record', node, grantedBy: actor,
});
await bindFortnoxScope(host, {
  connectionId: id, tenantId, scopeId, vertical,
  operation: 'ledger/record-period',   // yours
  permission: 'ledger:record',         // what it checks
});

// 4. Schedule the poll — YOUR deployment calls the sweep on a timer, as with Scrive.
const sweeper = (h, id, o) => sweepFortnoxLedger(h, id, { ...o });
//    Node:        startPlatformSweeper(host, { sweepers: { fortnox: sweeper }, intervalMs })
//    Cloudflare:  definePlatformSweeperDO (@substrat-run/adapter-cloudflare)
```

### Why you name the operation, and the connector does not

What comes out of Fortnox is neutral accounting fact: accounts, cost centres, months,
debit-positive sums. What a business *means* by them — which account is `lokal_grundhyra`, which
sign normalizes it, which group it rolls into — is **vocabulary**, and vocabulary is the vertical's
layer. A connector that mapped account numbers to row keys would be a vertical wearing a
connector's clothes, and the second customer with a different chart of accounts would have to fork
it.

So the connector hands you `FortnoxLedgerPage` and stops. Your operation does the mapping.

### `bindFortnoxScope` refuses without the grant, on purpose

A sweep has no delivered event, so it has neither a scope to write to nor authority to write with.
Scrive gets both from the ledger row it wrote when the event arrived; this connector has no such
moment, so the binding is the declaration — and it is verified when it is made.

Without that check the binding is written, and the missing grant surfaces on the next sweep: in a
background timer nobody is watching, after a year of bookkeeping has already been fetched. That is
the shape of [#841](https://github.com/substrat-run/substrat/issues/841). Here it fails in the
operator's hands, naming the permission to grant.

It is also why `FORTNOX_CONNECTION_GRANTS` is empty rather than absent: the permission is the
consumer's and cannot be declared at this package's build time, so the check moved from build time
to bind time rather than disappearing.

## Caveats worth knowing

1. **Your deployment must schedule the poll** (step 4). The connector provides the driver; it
   cannot hold a timer — that is a deployment concern. Without one wired, a binding is inert.

2. **The live round-trip is verified**, against a Fortnox test company (2026-09-03), and it
   found two real bugs — see caveat 3. `test/live.test.ts` runs the real API — mint,
   `companyinformation`, `financialyears`, `sie/4` — whenever `secrets/connectors.env` (shared
   by every connector) holds a complete credential, and skips otherwise, so CI without secrets
   stays green. `pnpm fortnox:connect` is what fills that file; `DatabaseNumber` is shown nowhere
   in the Developer Portal, so it cannot be typed by hand.

   What the live run settled: `grant_type=client_credentials` with a `TenantId` header really does
   mint with no refresh token in the response, and the envelopes really are `FinancialYears` /
   `CompanyInformation`. What it disproved is in caveat 3.

   `test/live.test.ts` reads only: the data calls are GETs, and the one POST is the token mint,
   which creates no Fortnox record. This connector has no write path to Fortnox at all, so
   running it against a production company cannot damage anything. Putting test data INTO a
   sandbox is therefore a separate script — `pnpm fortnox:seed` — which refuses any company whose
   organisation number is not Fortnox's sandbox marker `555555-5555`. Note that an empty sandbox
   makes the charset and double-entry assertions silently not run at all, so seed before judging
   a red.

3. **SIE4 is PC8 (code page 437) — not latin1, and not UTF-8.** The file says so in `#FORMAT`;
   the HTTP response does not. Decoding as UTF-8 throws on the first Swedish letter, which is the
   *good* failure. Decoding as latin1 is the bad one: every byte 0x00–0xFF is a valid latin1 code
   point, so nothing throws and no replacement character appears — you simply get account names
   with the wrong letters. **This connector shipped that way**, and the whole package stayed green,
   because `FortnoxMock` encoded latin1 too: the reader and the fixture agreed with each other
   while both disagreed with Fortnox. Only the live suite could see it.

   `decodeSie` (`src/sie4.ts`) owns the charset, reads `#FORMAT`, and refuses one it does not
   implement rather than guessing. `TextDecoder` is no help — CP437 is not in the WHATWG registry,
   and `TextDecoder('iso-8859-1')` is really windows-1252 — so it carries a mapping table for
   0x80–0xFF. `FortnoxMock` now encodes CP437 the way Fortnox does.

4. **Pick the financial year by OVERLAP, never containment.** A newly-acquired company's first
   financial year can start mid-month (24 April, say). A search for "the year containing 1 January"
   finds nothing and the sync reports empty books for a company with a full year of bookkeeping.
   `financialYearFor` does this correctly and is exported for callers that need to ask directly.

5. **Amounts are debit-positive, and this connector does not normalize them.** A cost account
   carries a positive amount for a cost; a revenue account (a credit) carries a negative one. That
   is correct double-entry, and inventing a sign here would put business meaning in a format
   reader. Your mapping applies the sign.

6. **A sync is all-or-nothing per scope, by cursor.** The content hash is written only after every
   page has landed, so a failure part-way leaves the cursor at the previous hash and the next sweep
   retries the whole year — rather than resuming into a half-written ledger. The `syncId` is that
   hash, so every page of one run shares it and a consumer can swap a whole run atomically.

## Testing

`FortnoxMock` implements the token endpoint and the three REST reads in memory, so the whole sweep
runs without a Fortnox account — credential minting, PC8/CP437 decoding, year selection, paging,
the unchanged-hash skip, and the bind-time grant refusal.

**What a mock proves:** that our shape works. **What it cannot prove:** that our reading of
Fortnox's API is correct — the mock *is* our reading. That is not a hypothetical here: the mock
encoded the wrong charset for as long as the reader decoded it, and they agreed with each other
right up until a real call disagreed with both. Green here means *ready to check against a real
company*, and the checking is `test/live.test.ts`.
