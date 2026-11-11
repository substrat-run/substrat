# The SCIM 2.0 server

The issuer serves a **SCIM 2.0 server** (RFC 7643, RFC 7644) at `/scim/v2`. An **identity
master** uses it to create the people it owns at the issuer before their first sign-in. A master
is a portal, or a vertical that manages its own people. Each person's `id` is their OIDC `sub`:
the one key every app already holds.

Beyond an ordinary create, the server can attach a **BankID**. A person's personal number becomes
the identity a BankID sign-in looks up. So their first BankID sign-in lands on the account the
master created, not on a placeholder that someone has to merge later. This works with open
registration turned off. The personal number is never returned, logged or written to the sign-in
log.

This server is **strict where implemented, explicit where not**. An attribute, query parameter or
endpoint it doesn't serve is refused in SCIM's error shape, never silently ignored. Every place it
differs from the RFCs is a row in [the table below](#where-it-differs-from-the-rfcs). If you find a
difference that isn't in it, that's a bug.

The read side, when each person last signed in to which app, is not SCIM. It is the Auth0
Management API subset in [MANAGEMENT-API.md](./MANAGEMENT-API.md).

## Turning it on

Nothing is served until an operator opts in, in two steps:

1. Add `users:provision` to the issuer's `MACHINE_SCOPES` setting. That's the ceiling on what any
   machine client may hold. Until it's there, the SCIM audience isn't even registered, so no token
   can be minted for it.
2. In the console, register a **machine** application and give it `users:provision`.

Then get a token with the client credentials grant, naming the SCIM audience:

```http
POST /oauth/token
Content-Type: application/json

{
  "grant_type": "client_credentials",
  "client_id": "…",
  "client_secret": "…",
  "audience": "https://<issuer>/scim/v2"
}
```

Then send it as a bearer token on every request. Every request re-checks the client and the
ceiling as they are at that moment. Disabling the client, removing the scope from it, or removing
the scope from `MACHINE_SCOPES` ends its access on its next request.

## What is served

| Endpoint | Notes |
|---|---|
| `GET /ServiceProviderConfig` | `patch`, `bulk` and `filter` supported; `sort`, `etag` and `changePassword` not. |
| `GET /ResourceTypes`, `/ResourceTypes/User` | One resource type, `User`, with the BankID extension. |
| `GET /Schemas`, `/Schemas/{id}` | The core User schema (the attributes this server stores) and the BankID extension. |
| `POST /Users` | Create. `?dryRun=true` is accepted (see [Dry run](#dry-run)). |
| `GET /Users/{id}` | `attributes`, `excludedAttributes`. |
| `GET /Users` | `filter`, `startIndex`, `count` (at most 200), `attributes`, `excludedAttributes`. |
| `PATCH /Users/{id}` | `add`, `replace` and `remove`. `?dryRun=true` is accepted. |
| `DELETE /Users/{id}` | `?dryRun=true` is accepted. |
| `POST /Bulk` | `POST /Users`, `PATCH /Users/{id}` and `DELETE /Users/{id}`, with `failOnErrors` and `bulkId:` references. At most 1000 operations and 1 MiB. `?dryRun=true` is accepted. |

Any other method or path under `/scim/v2` answers `501`, naming what was asked for. That covers
`PUT`, `/Groups`, `/Me` and `/.search`.

### A person

```json
{
  "schemas": [
    "urn:ietf:params:scim:schemas:core:2.0:User",
    "urn:substrat:params:scim:schemas:extension:bankid:2.0:User"
  ],
  "userName": "member-42",
  "externalId": "p-42",
  "name": { "givenName": "Anna", "familyName": "Andersson" },
  "emails": [{ "value": "anna@example.se", "type": "work", "primary": true }],
  "active": true,
  "urn:substrat:params:scim:schemas:extension:bankid:2.0:User": { "personalNumber": "YYYYMMDDNNNN" }
}
```

The attributes this server stores:

| Attribute | Notes |
|---|---|
| `id` | The person's `sub`. Assigned by the server. |
| `userName` | Required. Unique, compared case-insensitively, and stored lowercased. **Never a personal number:** a value shaped like one is refused. |
| `externalId` | The master's own id for the person. Filterable. |
| `name.givenName`, `name.familyName`, `name.formatted` | `formatted` is the issuer's display name, the same value as `displayName`. |
| `displayName` | The name relying parties see in the `name` claim. If neither it nor `name.formatted` is given, it is built from the given and family names, or else from the address's local part, or else from `userName`. |
| `emails` | At most one address. An address set over SCIM is stored **unverified**: the master only claims it. |
| `active` | `false` blocks the account and ends its sessions and stored tokens. |

#### Members with no email address

A member who signs in only with BankID may have no address. Their `userName` is then the
master's own stable id for them, such as its person id. It is never their personal number,
which is refused as a `userName`. The account holds the issuer's internal placeholder address,
which is never returned as an email.

An account always needs a way in: an email address, a personal number, or both. Removing an
address is refused unless a BankID is attached.

#### An account the master didn't provision

Every account the issuer holds can be found and read, so a master can see who it collides with.
Only the client that provisioned an account can write to it. Over SCIM, nobody can change or
delete:

- an account that signed up on its own;
- an account another client provisioned;
- an administrator.

Changing an account's address is the first step of taking it over. This issuer is shared across a
team's apps, so one master must not be able to do that to people it doesn't own.

A person who didn't come through SCIM is named by their address. With no address, they're named by
their `sub`.

### The BankID extension

Schema `urn:substrat:params:scim:schemas:extension:bankid:2.0:User`:

| Attribute | Mutability | Returned | Notes |
|---|---|---|---|
| `personalNumber` | `writeOnly` | `never` | Twelve digits, `YYYYMMDDNNNN` (a hyphen before the last four is accepted), with a valid check digit. A *samordningsnummer* is accepted. The ten-digit form is refused: its century would be a guess. |
| `linked` | `readOnly` | `default` | `true` when a BankID is attached. The only thing the response ever says about it. |

- **Attaching.** Sending `personalNumber` attaches the BankID, on create or with `PATCH` (`add` or
  `replace` on `urn:…:bankid:2.0:User:personalNumber`).
- **Re-sending.** Sending the number already attached changes nothing.
- **Changing or removing.** Changing an attached BankID to a different number, or removing it, is
  refused. Only an administrator can do either.
- **The number never leaves.** It is never in a response, an error message, a log line or the
  sign-in log. A refusal says what is wrong with the number's shape, never what it was.

### Conflicts

A conflict is **reported, never resolved**. If the address, the personal number or the `userName`
already belongs to another account, the answer is `409` with `scimType: "uniqueness"`. Nothing is
linked, merged or overwritten. In a Bulk request, each operation gets its own answer. The person
the master meant and the account that already exists have to be joined by an administrator, who
can check that they are the same person.

### Deactivating and deleting

- **`active: false`** blocks the account and ends every session it has, along with the access and
  refresh tokens the issuer stored for it. JWT access tokens are never stored, so one already
  issued lives out its hour; nothing new can be minted for a blocked account.
- **`active: true`** lifts a block set over SCIM. A block an administrator set stays, and is
  refused with `400 mutability`.
- **`DELETE`** removes the account, everything it signs in with, and its sessions and tokens.

### Dry run

**Not part of SCIM.** SCIM has no dry run, so this server adds one: `?dryRun=true` on
`POST /Users`, `PATCH /Users/{id}`, `DELETE /Users/{id}` and `POST /Bulk`.

- **How it runs.** The request runs for real inside a database transaction, which is then rolled
  back. The answer is the real run's own, status codes included. Within one Bulk request, later
  operations see what earlier ones would have written: two operations creating the same address
  report the second as a conflict, exactly as the real run will.
- **What it returns.**
  - Every dry-run response carries the header `Substrat-Dry-Run: true`.
  - A would-be-created person comes back without `id` or `meta.location`, because the real run
    mints its own.
  - A would-be-updated person comes back as they would be.
- **What persists.** Nothing.

A first migration, a few hundred people in one Bulk request, runs as a dry run first. Then it runs
for real once every conflict has been resolved by hand.

## Where it differs from the RFCs

### Calling it

| RFC 7644 | This server | Why |
|---|---|---|
| Any authentication scheme, often a long-lived bearer token. | Only a `client_credentials` access token for the audience `{issuer}/scim/v2`, holding `users:provision`. Tokens last one hour. No static token. | The issuer's machine-client model, the same as the Management API's. |
| A token is valid until it expires. | The client and scope are re-checked on every request against the client's row and `MACHINE_SCOPES` as they are then. | Stricter: the operator's switch takes effect at once. |
| Discovery endpoints MAY be served without authentication. | Every endpoint needs the token, discovery included. | Allowed by the RFC; fewer doors. |
| `PUT /Users/{id}` replaces a resource. | `501`. Use `PATCH`. | Not served. |
| `/Groups`, `/Me`, `/.search`. | `501`. | Not served. |
| `ETag` / `version`. | Not supported (`etag.supported: false`). | Not served. |
| `sortBy` / `sortOrder`. | Refused with `400 invalidSyntax`. | Not served (`sort.supported: false`). |
| A server may ignore a query parameter it doesn't know. | Refused with `400 invalidSyntax`. | Nothing is silently ignored. |
| The full filter grammar (`and`, `or`, `co`, `sw`, `pr`, …). | One `eq` comparison on `userName`, `emails.value`, `externalId` or `id`. Anything else is `400 invalidFilter`. | The lookups a provisioning client makes before it creates. |
| `attributes` / `excludedAttributes` name any attribute or sub-attribute. | Top-level attributes; a sub-attribute selects its whole parent. `id` and `schemas` are always returned. | Simpler projection. |
| A request is `application/scim+json`. | Also `application/json`. Responses are `application/scim+json`. | Lenient on input. |
| No dry run. | `?dryRun=true`, see [Dry run](#dry-run). | **Extension.** |

### The User resource

| RFC 7643 | This server | Why |
|---|---|---|
| Unknown attributes may be ignored. | An attribute this server doesn't store is refused with `400 invalidValue`, naming it. That includes `phoneNumbers`, `addresses`, `title`, `roles`, `groups` and the enterprise extension. | Nothing is silently dropped. Trim a directory's attribute mappings to the ones above. |
| `emails` holds any number of addresses. | At most one, or several with exactly one `primary`. The others are refused, not dropped. | The issuer holds one address per person. |
| `emails[type eq "…"].value` paths with any filter. | Any filter selects the one address. | One address per person. |
| `password` is writable. | Refused with `400 invalidValue`. The person sets their own password at the issuer. | A master never holds a person's password. |
| `name` has `middleName`, `honorificPrefix`, `honorificSuffix`. | Refused. | Not stored. |
| `active` is a boolean. | A boolean, or the strings `"true"`/`"false"` in any case. | Entra ID sends `"False"`. |
| PATCH `op` is `add`, `replace` or `remove`. | The same, in any case. | Entra ID sends `"Replace"`. |
| `meta.version`. | Absent. | No ETags. |
| A personal number has no standard attribute. | The BankID extension above. | **Extension.** |

### Errors

| RFC 7644 | This server |
|---|---|
| `{ schemas, status, scimType?, detail }` | The same shape. `status` is a string, as the RFC's examples have it. |
| A missing or invalid token is `401`. | The same, with `WWW-Authenticate: Bearer`. |
| A token without the scope. | `403`, `Insufficient scope, expected users:provision`. |
| Writing to a resource the client may not change. | `403`, naming why: not provisioned by this client, or an administrator. |
| An endpoint that doesn't exist is `404`. | One SCIM defines that this server doesn't serve is `501`. Not a SCIM code. |
| A `bulkId:` reference that can't be resolved. | `409 invalidValue` for that operation. |
| More than `maxOperations`, or more than `maxPayloadSize`. | `413`. |
