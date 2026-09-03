# Fortnox (accounting)

Reads a company's bookkeeping out of **Fortnox** as a SIE4 export, sums it per account, cost
centre and month, and lands the result into a scope through the consuming vertical's own
operation.

::: tip Verified against a live company — and it found two bugs
Every claim below has now been checked against `api.fortnox.se`, and two of them were wrong.
**The SIE4 export is PC8/CP437, not ISO-8859-1** — decoding it as latin1 turned every `ö` into
`”` in account names, silently, with no error anywhere. And `companyinformation` returns explicit
`null` for unset text fields, which the response schema rejected outright. Both are fixed; both
were invisible to a mock, because the mock encoded latin1 too and so agreed with the reader while
both disagreed with Fortnox.

The credential model is now proven rather than argued: `grant_type=client_credentials` with a
`TenantId` header really does mint, with no refresh token in the response.
:::
## At a glance

| | |
|---|---|
| **Provider** | Fortnox (Swedish accounting), REST API v3 + SIE4 export |
| **Category** | Accounting |
| **Status** | Live-verified against a Fortnox test company — poll-only, no outbound writes |
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
back to every customer. Note also that **every Fortnox scope grants read *and* write** — there is
no read-only variant — so an extra scope widens what the credential *could* do, even for a
connector like this one that has no write path at all.
:::

### What the customer needs before any of this works

Two prerequisites sit outside your code, and neither announces itself clearly when missing.

**The customer needs a Fortnox integration licence.** Connecting *any* third-party integration
requires it, it is bought by the **Fortnox customer** on their own subscription — not by you as the
integrator — and it is added once and then covers unlimited integrations. A customer who already
runs some other integration pays nothing more to add yours. One who does not will be stopped at the
consent screen by a purchase prompt, so it belongs in your onboarding text rather than as a
surprise mid-flow.

**Your scopes must be ticked on the integration in the Developer Portal.** The authorize endpoint
validates `scope` against what that integration registered, *before* login, and answers a bare
`invalid_scope` — naming neither which scope was refused nor that registration is the fix. With
several scopes in one request you cannot tell which one it objected to.

There is a quick way to find out, and it needs no browser: request the authorize URL one scope at a
time and read the `Location` header. A refused scope redirects straight back with
`error=invalid_scope`; an accepted one returns the login page.

```bash
curl -s -D - -o /dev/null \
  "https://apps.fortnox.se/oauth-v1/auth?client_id=$CLIENT_ID\
&redirect_uri=http%3A%2F%2Flocalhost%3A8899%2Fcallback\
&scope=companyinformation&state=probe&response_type=code&account_type=service" \
  | grep -i '^location:'
```

`redirect_uri`, by contrast, is validated only **after** login, so the same trick cannot tell you
whether a callback URL is registered — an unregistered one still returns the login page.

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

**SIE4 is PC8 — code page 437 — and getting this wrong is invisible.** The file declares it
(`#FORMAT PC8`), but the HTTP response does not: there is no charset in the content type. CP437 is
a pre-Unicode MS-DOS encoding, so `0x94` is `ö`, `0x84` is `ä`, `0x86` is `å`. Two traps follow.

*Decoding as UTF-8* throws on the first Swedish letter, which is the good case — you find out.
*Decoding as latin1* is the bad case: **every byte 0x00–0xFF is a valid latin1 code point**, so
nothing fails, and you get a ledger full of plausible-looking account names with the wrong letters
in them. This connector shipped that way, and every test in the package passed, because the mock
encoded latin1 too — the reader and the fixture agreed with each other while both disagreed with
Fortnox. Only a live call could see it.

Two consequences worth copying into any SIE reader you write:

- **`TextDecoder` cannot do this.** CP437 is not in the WHATWG Encoding registry, so
  `new TextDecoder('cp437')` throws `RangeError` in Node, browsers and Workers alike. A mapping
  table for bytes 0x80–0xFF is the only portable option. Note also that
  `new TextDecoder('iso-8859-1')` silently gives you **windows-1252**, which differs from latin1
  in exactly the 0x80–0x9F range where CP437 keeps its Swedish letters.
- **"No replacement character" is not a charset test.** Asserting that the decoded text contains
  no `�` cannot fail for a latin1 decode, so it proves nothing. Assert instead that no C1 control
  (`U+0080`–`U+009F`) appears *and* that the Swedish letters do — a chart of accounts has them.

`decodeSie` is the one place that knows, it reads `#FORMAT` and **refuses** a charset it does not
implement rather than guessing, and `FortnoxMock` now encodes CP437 the way the provider really
does.

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

1. ~~A live verification run.~~ **Done**, against a Fortnox test company. It found the charset
   bug above and a schema that rejected `null` in optional text fields, and it confirmed the two
   claims that mattered most: `client_credentials` mints with a `TenantId` header and no refresh
   token, and `DatabaseNumber` is what the header wants.

   `test/live.test.ts` runs whenever `secrets/connectors.env` (shared by every connector) holds
   `FORTNOX_CLIENT_ID`, `FORTNOX_CLIENT_SECRET` and `FORTNOX_TENANT_ID`, and skips otherwise, so
   CI without secrets stays green. Assembling that credential is not copy-paste — `DatabaseNumber`
   is shown nowhere in the portal — so `pnpm fortnox:connect` runs the one-time service consent
   locally, reads it, verifies `client_credentials` against it, and prints the line to add.

   The suite reads only: the data calls are GETs and the one POST is the token mint, which creates
   no Fortnox record. This connector has no write path to Fortnox, so it is safe against a
   production company too — and that property is worth protecting, which is why seeding a sandbox
   with test data lives in a **separate** script, `pnpm fortnox:seed`, that refuses to write to any
   company whose organisation number is not Fortnox's sandbox marker `555555-5555`.

   ::: warning An empty sandbox is worse than no sandbox
   A fresh test environment has no financial year and no vouchers. Three of the five live tests
   then fail on absent data rather than on a defect — and, far worse, the two assertions that
   matter most never execute: the charset check and the double-entry check both need a real export
   with real Swedish account names in it. An empty sandbox lets a broken decoder pass. Seed first,
   then judge a red.
   :::

2. **A consumer.** No vertical in this repo binds it yet, so the landing operation exists only in
   the test suite. The seam is proven; the first real mapping is not written.

3. **A deployment that schedules the sweep.** The connector provides the driver and cannot hold a
   timer. Without `startPlatformSweeper` or `definePlatformSweeperDO` wired, a binding is inert.

4. **Supplier invoices and their PDFs.** The `supplierinvoice`, `archive` and `connectfile` scopes
   exist and would let this read supplier invoices and fetch their files. Nothing here does — and
   because scopes cannot be widened after consent, a deployment that expects to want them should
   ask for them in the *first* consent round.
