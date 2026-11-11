# The Auth0 Management API subset

The issuer answers a **strict subset of the Auth0 Management API v2**, so an operator's own
app can ask it about its people with any client written against Auth0: `node-auth0`'s
`ManagementClient`, Terraform's Auth0 provider, or a hand-written `fetch`.

The rule is **strict where implemented, explicit where not**. An endpoint served here uses
Auth0's path, query parameters, field names and error body exactly. A parameter or endpoint the
subset does not serve is refused in Auth0's error shape, never silently ignored. Every place the
issuer differs from Auth0 is a row in [the table below](#where-it-differs-from-auth0). If you
find a difference that is not in it, that is a bug.

## Turning it on

Nothing is served until an operator opts in, in two steps:

1. Add `read:users` to the issuer's `MACHINE_SCOPES` setting. That is the ceiling on what any
   machine client may hold, and without it no token can read anyone.
2. In the console, register a **machine** application and give it `read:users`.

Then get a token the way Auth0 documents it:

```http
POST /oauth/token
Content-Type: application/json

{
  "grant_type": "client_credentials",
  "client_id": "…",
  "client_secret": "…",
  "audience": "https://<issuer>/api/v2/"
}
```

and call the API with it:

```http
GET /api/v2/users-by-email?email=ada@example.com
Authorization: Bearer <access_token>
```

With `node-auth0`, that is
`new ManagementClient({ domain: '<issuer host>', clientId, clientSecret })`.

## What is served

| Endpoint | Scope | Notes |
|---|---|---|
| `POST /oauth/token` | | `client_credentials` with `audience`, JSON or form body. Every other grant passes through to the issuer's own token endpoint. |
| `GET /api/v2/users-by-email` | `read:users` | `email` (required), `fields`, `include_fields`. Exact match, as Auth0's own database connections behave: addresses are stored lowercased. |
| `GET /api/v2/users/{id}` | `read:users` | `fields`, `include_fields`. |
| `GET /api/v2/users/{id}/x-client-activity` | `read:users` | **Extension, not Auth0.** See below. |

Any other method or path under `/api/v2` answers `501` with `errorCode: "not_implemented"`,
naming what was asked for.

### The extension: when each application last got a token

Auth0 keeps no record of when an application last got a token for a person, so this has no Auth0
shape to follow. The `x-` prefix keeps it from ever being mistaken for an Auth0 endpoint.

```json
{
  "user_id": "…",
  "clients": [
    { "client_id": "…", "name": "CRM", "last_token_at": "2026-11-03T08:12:44.120Z" }
  ]
}
```

A row is written each time the token endpoint mints a token for a person, which is an
authorization-code exchange or a refresh that returns an id token. A delegated token from RFC 8693
token exchange is not recorded: the person did not sign in to that application. A machine
client's own tokens are never listed. Rows are kept for as long as the person and the
application both exist.

On an install that existed before this feature, the first times are approximate. They come from
the stored refresh tokens, opaque access tokens and consents. A consent's time is when the person
agreed, not necessarily when a token was issued. An application that only ever got JWT access
tokens has no time until its next sign-in.

## Where it differs from Auth0

### Calling it

| Auth0 | This issuer | Why |
|---|---|---|
| A Management API token stays valid until it expires. | Every request re-checks the token's client and scopes against the client's row and `MACHINE_SCOPES` as they are now. Disabling the client, removing the scope from it, or removing the scope from `MACHINE_SCOPES` ends access on the next request. | Stricter: the operator's switch takes effect at once. |
| Management API tokens last 24 hours by default. | One hour. | The issuer's machine-token lifetime. |
| The token's `sub` is `{client_id}@clients`, and it carries `gty: "client-credentials"`. | `sub` is the client id, with `azp` and `client_id` beside it, and there is no `gty`. Typed `at+jwt` (RFC 9068). | The issuer's token format. A client that only sends the token never sees this. |
| The token response carries `access_token`, `token_type`, `expires_in`, `scope`. | Also `expires_at`. | An extra field; Auth0 clients ignore it. |
| User-scoped Management API tokens (`read:current_user`, …). | Not accepted. Only a `client_credentials` token is. | Not served. |
| Any Management API scope. | `read:users` only. | The subset. |
| `X-RateLimit-*` headers. | None. | Not served. |
| A `private_key_jwt` assertion's `aud` is `https://<domain>/oauth/token`. | Its `aud` must be the issuer's own token endpoint, as discovery names it. | `/oauth/token` passes the assertion through unchanged. |
| A client secret is accepted in the body or as HTTP Basic, whatever the application. | Also both: the console registers machine clients for HTTP Basic, and `/oauth/token` turns a secret posted in the body into that header. The issuer's own `/api/auth/oauth2/token` holds a client to its registered method. | Compatible at `/oauth/token`. |
| `audience` names the API. | `audience` at `/oauth/token`; RFC 8707 `resource` at `/api/auth/oauth2/token`. Naming both is a 400. | Both spellings are served, one per endpoint. |

### The user object

| Field | This issuer | Why |
|---|---|---|
| `user_id` | The issuer's own id, which is the OIDC `sub`. No `provider\|` prefix is added. A user imported from Auth0 keeps their Auth0 id, prefix and all. | The id is the `sub` every relying party already holds. |
| `email`, `email_verified` | Absent for a person who signed in with BankID and gave no address. | The issuer's stand-in address is not the person's, and Auth0 has no address for such a user either. |
| `identities[].provider` / `connection` | A password is `auth0` / `Username-Password-Authentication`, Auth0's default database connection. Every other provider keeps the issuer's own id for both: `google`, not Auth0's `google-oauth2`. | There is no faithful mapping to a tenant's connection names. |
| `identities[].user_id` | **Absent for BankID.** That identity's id is the person's personal number. | Never served. |
| `identities[].isSocial` | `false` for a password and BankID, `true` for every upstream sign-in. | Derived. |
| `identities[].profileData`, `access_token`, `refresh_token` | Never present. | Not stored, or not served. |
| `last_login`, `logins_count` | A login is a successful sign-in at the issuer, a sign-up included. Coming back through an existing session is not one. Creating the first administrator counts as one sign-in. An install that existed before this feature started from what its 30-day sign-in log and live sessions held, so a count from before then is low. | Counted from the issuer's own record. |
| `last_ip` | Never present. | The sign-in log keeps IP-level detail behind the admin console. The Management API serves times only. |
| `nickname`, `given_name`, `family_name`, `username` | Never present. | The issuer does not hold them. |
| `picture` | Present only when the person has one. Auth0 fills in a generated avatar. | No generated avatar. |
| `phone_verified` | Never present, even when `phone_number` is. | The issuer does not store it. |
| `app_metadata`, `user_metadata` | Never present. | Not supported. |
| `last_password_reset`, `multifactor` | Never present. | Not held. |
| `blocked` | `true` when the account is banned, absent otherwise. | Same as Auth0. |

### Errors

| Auth0 | This issuer |
|---|---|
| `{ statusCode, error, message, errorCode? }` | The same shape. `message` wording may differ from Auth0's. |
| An unknown query parameter is a 400, `invalid_query_string`. | The same. Each served endpoint takes every parameter Auth0 defines for it. |
| An unknown user is a 404, `inexistent_user`. | The same. |
| An endpoint that does not exist is a 404. | An Auth0 endpoint not in the subset is a **501**, `errorCode: "not_implemented"`. Not an Auth0 code. |
| A missing token is a 401, `Missing authentication`. | The same. |
| A missing scope is a 403, `insufficient_scope`. | The same. |
