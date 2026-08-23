# @substrat-run/dev-issuer

A local **OpenID Connect provider** you sign into by picking a name.

It exists so a [Substrat](https://github.com/substrat-run/substrat) vertical needs no dev-only
auth branch. Point a vertical at this issuer and it is an ordinary relying party running its
production login; point it at Auth0, Keycloak or your own issuer instead and nothing in the
vertical changes but `OIDC_ISSUER`.

**Full documentation: https://substrat.net/reference/dev-issuer**

> **Never deploy it.** Its signing key is checked into this repository, deliberately — see
> *Why the key is public* below. Nothing but a loopback relying party may trust it.

## Why it exists

The obvious way to move between users locally is a header — `x-principal: greta` — and it is a
bad trade twice over. It is an impersonation bypass one environment variable away from being
live, and it forks the auth path: the login you exercise all day is one no deployment runs, so
the real one is only ever tested in production. Moving the user-picker *out* of the vertical
and into an issuer removes both. The vertical keeps exactly one auth path.

## What it is

- **A real provider.** Discovery, JWKS, Authorization Code + PKCE, a signed ID token with
  `nonce`, RP-initiated logout. The single shortcut is that `/authorize` renders a list of
  people instead of a password field.
- **Stateless.** The authorization code *is* a short-lived JWT carrying subject, client,
  redirect URI, nonce and PKCE challenge — no code store, no session store. Two consequences:
  restarting invalidates nothing, and with no SSO cookie the picker appears on every
  `/authorize`, which is what makes switching user one click rather than a logout dance.
- **Loopback-only redirects.** Anything but `http://localhost`/`127.0.0.1`/`[::1]` is refused
  unless explicitly allowed, so a stray instance cannot be used as an open redirector.
- **Web-standard.** `jose` + Web Crypto, no `node:*` in the issuer itself.

## Running it

```bash
substrat-dev-issuer --personas src/personas.ts    # defaults to :8879, or $ISSUER_PORT
```

`--personas` names a module exporting `PERSONAS: DevPersona[]`. Point it at the vertical's own
file so the picker's cast and the identity links the seed writes are the same array:

```ts
import type { DevPersona } from '@substrat-run/dev-issuer';

export const PERSONAS: DevPersona[] = [
  { sub: 'dev|greta', name: 'Greta', email: 'greta@example.test', note: 'workshop-admin' },
  { sub: 'dev|mans',  name: 'Måns',  email: 'mans@example.test',  note: 'mechanic' },
];
```

`sub` is the join. The issuer asserts it; your seed binds it to a principal with
`linkIdentity`. Keep the values stable and readable — they end up in a directory that outlives
a restart.

## The relying-party half

`devLogin` is the other side, for a vertical's dev server — the two steps a hosted deployment
also performs, written once rather than per demo:

```ts
import { devLogin } from '@substrat-run/dev-issuer';

const login = devLogin({ directory: host.admin, actor: staff, provider: 'oidc:dev-issuer' });

app.on(['GET', 'POST'], '/api/auth/*', (c) => login.handle(c.req.raw)); // login/callback/logout
const caller = await login.caller(req.headers);   // { principal, tenantId, scopeId, … } | null
```

`caller()` verifies the request (session cookie, or a bearer for a script) and resolves the
`sub` through your identity directory. `subject()` returns the issuer's answer unresolved, for
verticals that know which tenant to ask about themselves.

## Without a browser

Tests and headless scripts mint tokens directly:

```bash
curl -XPOST localhost:8879/dev/token -d '{"sub":"dev|greta"}'   # → id_token + access_token
```

This *is* impersonation, and its address is the point: a process bound to localhost that is
never deployed, rather than a flag inside the thing that ships.

## Why the key is public

A relying party verifies an ID token against the issuer's JWKS, so the issuer needs a keypair.
Generating one at boot would invalidate every session on every restart, and every `/dev/token`
bearer a test run is holding. So the key is fixed — and fixed means public, since it lives in
this repository and anyone can mint a token it will validate.

That is the right posture for a process that binds to localhost, hands out logins by clicking a
name, and is never deployed. It is also exactly why no production relying party may point at
it: the trust anchor is a file in a public repo.

## Status

Pre-release (0.x): interfaces change without notice. `hono` is a peer dependency.
