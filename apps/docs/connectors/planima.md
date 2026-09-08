# Planima (facility maintenance)

Reads a **maintenance plan** out of [Planima](https://planima.se/) — facilities, buildings,
components, and the costed actions a property owner intends to carry out in a given year — and
lands it into a scope through the consuming vertical's own operation.

::: warning Not yet verified against a live account
Everything below is written from [Planima's published OpenAPI
document](https://developer.planima.se/) and is checked by a mock that encodes the same reading.
That means mock and client can agree with each other while both disagree with Planima. The
`connector-fortnox` page above is what that looks like when it goes wrong — two premises held for
months because the mock shared them.

`test/live.test.ts` is written and skips until `PLANIMA_TOKEN` is present. Until it has run, treat
the credential shape, the paging envelope and the nullability of every field as *claims*, not
facts.
:::

## At a glance

| | |
|---|---|
| **Provider** | Planima (Swedish planned facility maintenance), REST API v1 |
| **Category** | Facility maintenance |
| **Status** | **Built, not yet live-verified** — poll-only, read-only, no outbound writes |
| **Package** | `@substrat-run/connector-planima` — `0.x` |
| **Consumes** | *nothing* — this connector answers no event |
| **Registered with** | *nothing* — `sweepPlanimaPlan` is bound into the platform sweeper |

## What it consumes

**Nothing, and that is the design** — the same shape as
[Fortnox](/connectors/fortnox), and for the same reason. Nobody inside a scope initiates this. A
vertical does not *ask* for next year's maintenance plan the way it asks for a signature; the plan
changes in Planima — a surveyor walks a roof and moves an action from 2031 to 2027 — and the
platform finds out by looking.

So there is no `registerConnector` call and no dispatch handler. `sweepPlanimaPlan` is a sweeper,
the deployment binds it into the platform sweeper beside Fortnox's, and that is the entire trigger
surface.

What replaces the event is a **binding**: a one-time, explicit declaration of which scope this
connection syncs into, made by `bindPlanimaScope`.

```ts
await bindPlanimaScope(host, {
  connectionId,
  tenantId,
  scopeId,
  vertical: 'maintenance',
  operation: 'maintenance/record-plan', // the CONSUMER's operation
  permission: 'plan:record',            // which that operation checks
  organizationId: 1,                    // or null for every one the token sees
  horizonYears: 10,                     // rolling: this year .. this year + 10
});
```

`bindPlanimaScope` **refuses a binding whose grant is missing**, naming the permission to grant.
That is deliberate and it is the whole reason binding is a function rather than a config object:
the alternative is to write the binding, then discover at sweep time that the connection cannot
invoke the operation — in a background timer nobody is watching, with a whole maintenance plan
already fetched against a rate limit that only allows ten requests every ten seconds.

## The credential

**One static API token, and nothing else.** A person creates it in Planima under *account settings
→ API*.

| Stored | Never stored |
|---|---|
| `token` — the API token, sealed by the host's `SecretBox` | a Planima password; there is no OAuth flow, so no refresh token and no rotation hazard |

Two things about this token are worth stating plainly, because they are the entire security model:

1. **It carries the access level of the user who minted it.** There are no scopes. A read-only
   user's token cannot write; an admin's token can do everything that admin can. So the narrowing
   that matters is operational — **mint it as a read-only user**. This connector never writes, so
   nothing is lost by doing so, and a leaked read-only token costs a plan someone could already
   see.
2. **It does not expire.** That removes the rotation hazard Fortnox's refresh tokens carry, and
   replaces it with a different one: revocation is out-of-band, so the first the platform hears of
   a revoked token is a `401`. `PlanimaApiError.refused` is what carries that distinction — a
   `401` marks the connection unhealthy, while a timeout or a `429` does not, because neither is a
   fact about the credential.

The connect-time probe reads `/organizations` rather than merely checking the token parses. That
is the cheapest authenticated read Planima offers *and* it answers the question an operator
actually has: not "is this token valid" but "does it see the account I meant". A token from the
wrong Planima login is perfectly valid and syncs somebody else's buildings.

## The flow

One sweep pass, per bound scope:

1. `GET /facilities` (optionally `?organization_id=`) — every facility the token can see.
2. For each facility, in order: `GET /facilities/{id}/buildings`, `GET
   /facilities/{id}/components`, `GET /actions?facility_id={id}&start_year=…&end_year=…`.
3. Assemble, sort by id, and hash. **An unchanged hash lands nothing.**
4. Otherwise page the plan and `invoke` the consumer's operation once per page, as the connection
   itself.
5. Write the cursor — but only **after** every page landed, so a failure mid-way leaves the
   previous hash in place and the next sweep retries the whole plan rather than resuming into a
   half-written one.

### Four things the API will bite you with

**The `Authorization` header is the bare token.** No `Bearer` prefix. Planima's own example is
`-H "Authorization: NotARealToken+tm6rdPsx23u+4/HiguLIFQw="`, and a prefix fails identically to a
bad token — a `401` that reads like a credential problem and is not. The mock refuses a prefix for
exactly this reason.

**`page[limit]` is capped at 50, silently.** Asking for 500 returns 50 with no error and no hint
that the answer was cut, so a client that trusts its own limit and stops after one page syncs a
truncated plan and reports success. The walk asks for 50 and pages until a short page arrives.

**Ten requests per ten seconds, per token.** A sweep costs *at least* `1 + 3 × facilities`
requests — twenty facilities is sixty-one requests and about a minute of mostly waiting — and any
collection over the 50-item page cap adds more. The client throttles itself with a sliding window
shared across every binding in a pass (Planima meters per token, not per client) and, when Planima
answers `429`, obeys the `Retry-After` it sends rather than backing off on a schedule of its own
invention. That is why the sweep interval is a real decision rather than a free knob.

**There is no currency anywhere.** Planima sends `unit_price: 1200` and nothing else — no currency
on the action, the facility, the organization or the account. Substrat money is an
`{ amount, currency }` pair that cannot be built without one, so the **binding declares it**,
defaulting to `SEK`. It is a value this connector chose, not one it read, and naming it on the
binding is what keeps that visible.

### What the sweep does *not* save

An unchanged plan skips the **writes**, not the round trips. Planima offers no collection-level
`updated_at` or ETag to ask "has anything changed" cheaply, so every pass costs its full request
budget whether or not anything moved. Saying so is the point — a connector that implied otherwise
would make the sweep interval look free.

## Where the data lands, and why the connector does not decide

Pages are global across one sync and each names exactly one facility. A facility's buildings and
components ride its **first** page (`facilityHead`); actions ride every page, 500 at a time;
`final` marks the last page of the whole sync.

A sync that finds **no facilities at all** lands exactly one page with `facility: null`,
`actions: []` and `final: true` — a *clear* page. Landing nothing would be the one answer that
corrupts a consumer: it swaps on `final`, so a silent pass would leave last month's plan in place
for ever while the cursor recorded the empty plan as synced, and no later sweep would repair it. So a consumer upserts on `facilityHead`, appends
actions as they arrive, and commits or swaps on `final`. Every page of one sync carries the same
`syncId` — which *is* the content hash — so a redelivered page cannot double a cost.

What lands is neutral Planima fact: a component, a year, a price, a status string. What a business
*means* by any of it — which status counts as committed spend, which category rolls into which
budget line, whether a deferred action still books — is vocabulary, and vocabulary is the
vertical's layer. A connector that mapped statuses to budget states would be a vertical wearing a
connector's clothes, and the second customer who categorises differently would have to fork it.

One consequence worth naming: **`status` is passed through unmapped and unvalidated.** Planima
types it as a plain `string` even though it documents eight values for the matching filter, so a
ninth is an ordinary product change rather than a protocol break. Parsing against a closed set
would turn that into a sweep-wide throw — a whole tenant's plan failing to land because one action
moved to a status added last week.

## What's missing

- **A live verification.** The one that matters. Everything here is read from the OpenAPI document
  and held up by a mock that shares its assumptions. `connector-fortnox` shipped two wrong
  premises that way.
- **No outbound half.** Planima can create and update organizations, facilities, buildings and
  components; this connector uses none of it. That is a deliberate first cut — no vertical has
  asked for a write path, and adding one forfeits the read-only-token argument above. When one
  does, it belongs behind an event and a dispatch, in the shape `connector-scrive` already has.
- **Projects, categories and component types are not synced.** `GET /projects`,
  `GET /categories` and `GET /component_types` exist and are not read. Actions carry their
  `project_id` and their category *name*, which is enough for a consumer to group by; the
  catalogue reads would cost three more requests per pass against a tight budget for data that
  changes rarely.
- **No incremental sync.** The whole window is re-read every pass because the API offers no
  "changed since" filter. `updated_at` is on each row but cannot be filtered on.
