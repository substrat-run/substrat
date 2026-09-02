# Fortnox (accounting)

Reads a company's bookkeeping out of **Fortnox** as a SIE4 export, sums it per account, cost
centre and month, and lands the result into a scope through the consuming vertical's own
operation.

::: warning Built, and not yet verified against a real company
Every part of this connector runs green against `FortnoxMock` — minting, decoding, year selection,
paging, the unchanged-hash skip. But a mock is the author's reading of the documentation on both
sides of the call, and three claims here rest on documentation rather than measurement: that
`grant_type=client_credentials` mints as described, that the SIE4 response really is ISO-8859-1,
and that the response envelopes are `FinancialYears` / `CompanyInformation`. `test/live.test.ts`
checks all three against the real API and **skips** until a credential is present. It is a `0.x`
release for exactly this reason. See [What's missing](#what-s-missing).
:::

## At a glance

| | |
|---|---|
| **Provider** | Fortnox (Swedish accounting), REST API v3 + SIE4 export |
| **Category** | Accounting |
| **Status** | Built, unverified against a live company — poll-only, no outbound writes |
| **Package** | `@substrat-run/connector-fortnox` — `0.x` |
| **Consumes** | *nothing* — this connector answers no event |
| **Registered with** | *nothing* — it is a `ConnectorSweeper`, bound into the platform sweeper |

## What it consumes

**Nothing, and that is the design.** Every other connector so far answers an event: a vertical
does something, the engine emits, the connector effects it outside. This one runs the other way.
Nobody inside a scope initiates it — a vertical does not *ask* for last month's bookkeeping the
way it asks for a signature. The books change at Fortnox, and the platform finds out by looking.

So there is no `registerConnector` call and no dispatch handler. `sweepFortnoxLedger` is a
[`ConnectorSweeper`](/connectors/#the-seam-a-connector-plugs-into), the deployment binds it into
the platform sweeper beside Scrive's, and that is the entire trigger surface.

What replaces the event is a **binding**: a one-time, explicit declaration of which scope this
connection syncs into, which operation the ledger lands through, and which permission that
operation checks.

```ts
await bindFortnoxScope(host, {
  connectionId, tenantId, scopeId, vertical,
  operation: 'ledger/record-period',   // yours
  permission: 'ledger:record',         // what it checks
});
```

`bindFortnoxScope` **refuses when the connection does not hold that permission on that scope**.
A sweep can therefore never be configured into a state where it fetches a year of bookkeeping and
then cannot write it down — the failure lands in the operator's hands, naming what to grant,
instead of in a background timer nobody is watching.

## The credential

Fortnox's usual flow is OAuth2 authorization-code: a person signs in, you store an access token
and a **refresh token**, and you refresh forever. This connector deliberately does not do that.

Fortnox refresh tokens are **single-use and rotating** — each refresh mints a new one and
invalidates the old. Two concurrent refreshes therefore race: one wins, the other receives
`invalid_grant` and writes an already-dead token, and the connection is bricked until someone
reconnects it by hand. Every integration built that way carries the same three mitigations
(coalescing concurrent refreshes per company, optimistic locking on the token write, a distinct
"reconnect Fortnox" error).

**This connector holds no refresh token, so it cannot reach that state.** Fortnox supports
`grant_type=client_credentials` against a *service* consent, and a token minted that way comes from
three static values:

| Field | What |
|---|---|
| `clientId` | From the Fortnox Developer Portal — the integration's identity |
| `clientSecret` | From the Developer Portal — sealed at rest by the host's `SecretBox` |
| `tenantId` | The **company's numeric `DatabaseNumber`**, sent as the `TenantId` header |

```
POST https://apps.fortnox.se/oauth-v1/token
Authorization: Basic base64(clientId:clientSecret)
TenantId: 123456
grant_type=client_credentials
→ { access_token, token_type, expires_in: 3600, scope }     // note: no refresh_token
```

An access token lives an hour and is minted on demand, cached for the life of one sweep pass. One
client pair serves a whole fleet; `tenantId` is the only part that differs per company.

**What is never stored:** nothing sensitive beyond the client secret. This connector reads
bookkeeping totals — accounts, cost centres, months, sums. It never reads a customer register, a
supplier invoice, or an employee record, and it writes nothing back to Fortnox at all.

### The one-time consent

Client credentials are not consent-free. Each company's sysadmin authorizes once, in a browser,
and the consent must be created with **`account_type=service`** — that is what makes it mintable
by client credentials afterwards.

```ts
fortnoxConsentUrl({ clientId, redirectUri, state, scopes: ['bookkeeping', 'companyinformation'] });
// always sets account_type=service and access_type=offline
```

Your callback exchanges the code once, reads `GET /3/companyinformation` for `DatabaseNumber`, and
that number becomes the connection's `tenantId`. The code path is never used again.

::: danger Scopes cannot be widened without a new consent round
Ask for what the integration will need, not what it needs today. Fixing this later means going
back to every customer.
:::

## The flow

Per bound scope, each sweep pass:

1. **Mint** an access token (cached for the pass — one mint, not one per request).
2. **`GET /3/financialyears`** and pick the year that **overlaps** the period.
3. **`GET /3/sie/4?financialyear=<id>`** — the whole year's bookkeeping in one request, instead of
   walking per-voucher REST endpoints.
4. **Hash** the payload. Unchanged since last sync ⇒ stop here, land nothing.
5. **Parse** the SIE4 (`#VER` / `#TRANS`, plus `#KONTO`, `#DIM`, `#OBJEKT` for labels).
6. **Sum** per (account, cost centre, month) with exact decimal arithmetic.
7. **Land** it in pages of 500 through the binding's operation, as the connection itself.

The cursor is written **only after every page lands**, so a mid-way failure leaves it at the
previous hash and the next sweep retries the whole year rather than resuming into a half-written
ledger.

### Four things the format will bite you with

These are not incidental; each one produces wrong data rather than an error.

**SIE4 is ISO-8859-1, and nothing in the response says so.** Decoding as UTF-8 does not throw — it
silently mangles every å/ä/ö in every account name and cost-centre label. That is a corrupted
ledger that looks like a working one. `FortnoxApi.sieFile` is the only place that knows, and
`FortnoxMock` serves real latin1 bytes so a regression fails in the suite.

**Pick the year by overlap, never containment.** A newly-acquired company's first financial year
can start mid-month (24 April, say). Searching for "the year containing 1 January" finds nothing,
and the sync reports empty books for a company with a full year of bookkeeping.

**Amounts are debit-positive, and this connector does not normalize them.** A cost account carries
a positive amount for a cost; a revenue account (a credit) carries a negative one. That is correct
double-entry — inventing a sign here would put business meaning in a format reader. Your mapping
applies the sign.

**`#IB` / `#UB` / `#RES` are skipped.** They are the opening and closing balances the vouchers
already sum to. A reader that adds them to the `#TRANS` rows reports every figure twice.

### Cost centres come free

SIE reserves **dimension 1** for *kostnadsställe*, and Fortnox follows the standard. So a
per-property or per-unit breakdown needs no extra API call and no server-side filtering — it is
read straight out of each transaction's object list, and `#OBJEKT` rows carry the labels.

## Where the data lands, and why the connector does not decide

The connector hands you a `FortnoxLedgerPage` — neutral accounting fact — and stops.

What a business *means* by those numbers (which account is `lokal_grundhyra`, which sign
normalizes it, which group it rolls into) is **vocabulary**, and vocabulary is
[the vertical’s layer](/verticals/). A connector that mapped account numbers to row keys
would be a vertical wearing a connector's clothes, and the second customer with a different chart
of accounts would have to fork it.

This is also why the connector declares **no standing grants**. Every other connector names its
return-path permissions so the dashboard's door can be checked against them; this one's permission
belongs to the consuming vertical and is unknown at build time. The check moves from build time to
bind time rather than disappearing — see `bindFortnoxScope` above.

## What's missing

1. **A live verification run.** The three claims in the banner — client-credentials minting, the
   latin1 encoding, the response envelopes — are read from Fortnox's documentation and asserted
   against a mock built from that same reading. `test/live.test.ts` checks all three against the
   real API and skips until `connectors/fortnox/.dev.vars` holds a credential. It is entirely
   read-only (every call is a GET, and this connector has no write path to Fortnox), so it is safe
   to run against a production company.

2. **A consumer.** No vertical in this repo binds it yet, so the landing operation exists only in
   the test suite. The seam is proven; the first real mapping is not written.

3. **A deployment that schedules the sweep.** The connector provides the driver and cannot hold a
   timer. Without `startPlatformSweeper` or `definePlatformSweeperDO` wired, a binding is inert.

4. **Supplier invoices and their PDFs.** The `supplierinvoice`, `archive` and `connectfile` scopes
   exist and would let this read supplier invoices and fetch their files. Nothing here does — and
   because scopes cannot be widened after consent, a deployment that expects to want them should
   ask for them in the *first* consent round.
