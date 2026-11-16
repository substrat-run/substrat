# Bolagsverket (company register)

Checks a Swedish **organisation number** against [Bolagsverket](https://bolagsverket.se/), the
Swedish Companies Registration Office, through its free *API för värdefulla datamängder* (the EU
high-value datasets API). For a number that names a registered company it returns the registered
name, legal form, postal address, SNI codes and registration date, and whether the company is
active, deregistered, in liquidation, bankrupt or in reorganisation.

The credential is **your tenant's own**: you apply to Bolagsverket, and paste the client id and
secret they send into the dashboard. Nothing is shared across tenants.

::: warning Connection only, and not yet verified against Bolagsverket
Today you can store your credential and press **Test connection**. An app **cannot yet ask the
platform for a validation** — there is no dispatch to call (see [What's missing](#what-s-missing)).

No credential has been issued to the platform yet either. The URLs and the response shape are read
from community client libraries, not from a recording or from Bolagsverket's own OpenAPI document,
and a fixture suite holds the client to that reading. `test/live.test.ts` is written and skips
until test credentials are present. Until it has run, treat the response shape as a *claim*.
:::

## At a glance

| | |
|---|---|
| **Provider** | Bolagsverket, *API för värdefulla datamängder* v1 |
| **Category** | Company registers |
| **Status** | **Connection only, not yet live-verified** |
| **Package** | `@substrat-run/connector-bolagsverket` — private until its first release |
| **Consumes** | *nothing* — no event triggers it |
| **Registered with** | the platform's connection store; `sweepBolagsverket` is a no-op |
| **Cost** | free, no agreement needed |

## What it does

One lookup: `POST /organisationer` by organisation number, plus `GET /isalive` for health.

- **Lookup is by number only.** The API offers no search by name, so it cannot back an
  autocomplete.
- **Legal entities only.** A sole trader's organisation number *is* their personnummer. The
  connector refuses one locally, so a person's identity number is never sent to Bolagsverket and
  never stored.
- **Not included:** board members, signatories and beneficial owners (they sit behind Bolagsverket's
  paid API), and annual reports.

## Validating a number

The number is checked on our side first, and a bad one is **never sent** — not even the token
request is made.

Accepted forms are `NNNNNN-NNNN`, ten bare digits, or twelve digits with the `16` prefix, with or
without surrounding whitespace. Then:

| Check | Refused as |
|---|---|
| Not ten digits (or twelve with the `16` prefix) | `invalid_orgnr`, reason `format` |
| Luhn check digit fails | `invalid_orgnr`, reason `checksum` |
| Looks like a person's number: a month in digits three and four (a company's has 20 or more there), or a `19`/`20` century prefix | `invalid_orgnr`, reason `personnummer` |

A well-formed number the register has no entry for is **`exists: false`**. That is an answer, not
an error. A result also carries `source` (provider and environment) and `fetchedAt`. There is no
cache per number: a status can change from one day to the next, so `fetchedAt` is there for the
caller to decide how fresh a validation has to be.

## The credential

**An OAuth2 client id and secret, and nothing else.**

| Stored | Never stored |
|---|---|
| `clientId` and `clientSecret`, sealed by the host's `SecretBox` | a token — the connector mints a short-lived one from the pair, caches it, and mints another a minute before it expires |

There is no sign-in round: the dashboard's Bolagsverket door takes the two fields directly, and a
re-paste rotates the pair in place. The secret shows only its last four characters afterwards.

### Getting one

There is **no self-service sign-up**, and this is a task for a person at your organisation:

1. Submit Bolagsverket's
   [kundanmälan](https://bolagsverket.se/apierochoppnadata/hamtaforetagsinformation/vardefulladatamangder/kundanmalantillapiforvardefulladatamangder.5528.html).
   It needs a real email address (not a noreply address) and a mobile number.
2. Bolagsverket sends a client id and secret for **both** their test and production environments.
   Expect days rather than hours; they have warned that support is slow.
3. Paste the pair for the environment you want into the dashboard.

Bolagsverket issues a separate pair per environment, so a test pair against production fails as a
refused credential.

## The connection and its probe

One connection per tenant and app. The 60-requests-a-minute limit Bolagsverket applies is metered
**per client**, so with your own pair it is yours alone.

**Test connection** works at two moments, with the same check:

- **Before it is stored** — a pasted pair is probed first, so a mistyped one is refused at the form
  instead of looking healthy until the first real lookup fails.
- **On a stored connection** — and this one is a *use*, so it is recorded in the connection's
  health.

The probe mints a token and pings. A client credential names no account, so there is no company
name to show; the result names the **environment** (`prod` or `test`) and the **scopes** granted.
A client granted the ping scope but not `vardefulla-datamangder:read` **fails** the probe: it would
pass a ping and then fail every lookup.

A refused credential (`invalid_client`, a `401` that survives one re-mint, a `403`) marks the
connection unhealthy. A timeout, a `5xx` or a `429` does not, because none of them says anything
about the credential.

## Environments

The platform uses **production** unless the control plane is configured with `BOLAGSVERKET_ENV=test`.
`BOLAGSVERKET_TOKEN_URL` and `BOLAGSVERKET_API_BASE` override the hosts for either.

| | Token URL | API base |
|---|---|---|
| Production (default) | `portal.api.bolagsverket.se/oauth2/token` | `gw.api.bolagsverket.se/vardefulla-datamangder/v1` |
| Test | `portal-accept2.api.bolagsverket.se/oauth2/token` | `gw-accept2.api.bolagsverket.se/vardefulla-datamangder/v1` |

These hosts come from community client libraries and are to be checked against Bolagsverket's own
documentation once credentials exist.

## Rate limit

Sixty requests a minute per client. The client keeps a sliding window and waits when the sixty-first
request is due. On a `429` it waits as `Retry-After` says, up to three times; a probe does not retry
at all, because a rate limit says nothing about the credential and a person is waiting at a form.

## Errors

| `code` | Meaning |
|---|---|
| `invalid_orgnr` | refused locally, never sent; `reason` says why |
| `refused` | Bolagsverket turned the client away |
| `rate_limited` | a `429` that outlasted the retries; carries the provider's wait |
| `upstream` | anything that says nothing about the credential: a `5xx`, a timeout, a body not in the expected shape |

## What's missing

- **A live verification.** The one that matters. Credentials are a human step with Bolagsverket;
  until a run against their test environment has checked the response shape, every field here is
  read from community clients.
- **No dispatch.** The client validates a number, but an app has no operation to ask the platform to
  do it, and nothing lands in a scope. The connection's standing grants are empty for the same
  reason. This is the next step.
- **No cache, and no audit trail beyond `source` and `fetchedAt`.** Whether a validation should be
  cached per number, and whether the validated entity should keep those two fields, are open.
- **No name search, and no sole traders.** SCB's *Företagsregistret* would cover both, but it
  authenticates with a client certificate and is a connector of its own, not built.
- **No annual reports.** The API serves them (iXBRL, 2020 onwards); this connector does not read
  them.
