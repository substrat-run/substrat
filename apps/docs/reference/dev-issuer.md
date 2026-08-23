# @substrat-run/dev-issuer

A local **OpenID Connect provider** you sign into by picking a name — so a vertical needs no
dev-only auth branch.

Point a vertical at it and the vertical is an ordinary relying party running the login its
users will run. Point it at Auth0, Keycloak, the `auth-server` demo issuer or
your own issuer instead, and nothing in the vertical changes but `OIDC_ISSUER`. That is the
whole design: **dev and production differ by configuration, not by code path.**

```sh
substrat-dev-issuer --personas src/personas.ts    # :8879, or $ISSUER_PORT
```

::: danger Never deploy it
Its signing key is checked into the repository, deliberately — see
[Why the key is public](#why-the-key-is-public). Nothing but a loopback relying party may
trust it.
:::

## The problem it removes

The obvious way to move between users locally is a header the server believes:
`x-principal: greta`. It is a bad trade twice over.

It is an **impersonation bypass** — a caller naming whoever they like — sitting inside the
thing you deploy, one environment variable from being live. And it **forks the auth path**:
the vertical grows a second way to resolve a caller, its SPA grows a second mode to talk to
it, and the login exercised all day in dev is one no deployment ever runs. The real login is
then only ever tested in production, which is the same defect class as a route that exists in
`server.ts` and 404s in `worker.ts`.

Moving the picker *out* of the vertical and into an issuer removes both at once. The picker
still exists — it is just on the other side of a real OIDC redirect.

## What it is

- **A real provider.** Discovery, JWKS, Authorization Code + PKCE, a signed ID token with
  `nonce`, RP-initiated logout. The single shortcut is that `/authorize` renders a list of
  people instead of a password field.
- **Stateless.** The authorization code *is* a short-lived JWT carrying subject, client,
  redirect URI, nonce and PKCE challenge. There is no code store and no session store.
- **Loopback-only redirects.** Anything but `http://localhost` / `127.0.0.1` / `[::1]` is
  refused unless explicitly allowed, so a stray instance cannot serve as an open redirector.
- **Web-standard.** `jose` + Web Crypto; no `node:*` in the issuer itself.

Statelessness buys two things worth naming. Restarting invalidates nothing, so a dev server
and a test script restart independently of each other. And with no SSO cookie the picker
appears on **every** `/authorize` — which is exactly what you want here: switching user is one
click, and `prompt=select_account` needs no special handling because it is already the only
behaviour.

## Endpoints

| Path | What it does |
|---|---|
| `/.well-known/openid-configuration` | discovery; `issuer` derives from the request origin unless pinned |
| `/authorize` | without `sub`, the picker; with a known `sub`, issues the code |
| `/token` | `authorization_code` only; PKCE **is** verified, the client secret is not |
| `/jwks.json` | the one public signing key |
| `/userinfo` | the persona's claims behind a bearer |
| `/logout` | RP-initiated; honours `post_logout_redirect_uri` |
| `/dev/token` | mints tokens for a `sub` with no browser |
| `/dev/personas` | the cast, as JSON |

The client secret is accepted and **not** checked. An issuer that registers no clients has no
secret to compare against, and pretending otherwise would mean inventing the registration step
this exists to remove. PKCE is checked, because it is what binds an exchange to the browser
that began it — and the platform's relying party always sends it.

## The personas file

`--personas` names a module exporting `PERSONAS: DevPersona[]`. Point it at the vertical's own
file, so the picker's cast and the identity links the seed writes are the same array and
cannot drift:

```ts
import type { DevPersona } from '@substrat-run/dev-issuer';

export const PERSONAS: DevPersona[] = [
  { sub: 'dev|greta',  name: 'Greta',  email: 'greta@example.test',  note: 'workshop-admin' },
  { sub: 'dev|mans',   name: 'Måns',   email: 'mans@example.test',   note: 'mechanic' },
  { sub: 'dev|rutger', name: 'Rutger', email: 'rutger@other.test',   note: 'a DIFFERENT shop' },
];
```

`sub` is the join between the two halves. The issuer asserts it; your seed binds it to a
principal with [`linkIdentity`](/concepts/identity), naming the tenant and scope that persona
lives in. That link is what carries Rutger into the other tenant, so the cross-tenant beat
still runs with no persona table anywhere in the server.

Keep `sub` values stable and readable. They end up in a directory that outlives a restart, and
someone reading `_substrat_identities` should be able to tell who `dev|greta` is.

Note what is **not** in that file: no roles, no employee ids, no "which customer this person
belongs to". Those are domain facts, and they belong to operations the vertical already has —
a `whoami`, a scope's own tables. A persona cast that carries them makes them true locally and
guesswork everywhere else.

## The relying-party half

`devLogin` is the other side, for a vertical's dev server. It performs the same two steps a
hosted deployment does — verify the request against the issuer, then resolve the subject
through the identity directory — written once rather than per vertical, since it is
security-relevant glue:

```ts
import { devLogin } from '@substrat-run/dev-issuer';

const login = devLogin({ directory: host.admin, actor: staff, provider: 'oidc:dev-issuer' });

app.on(['GET', 'POST'], '/api/auth/*', (c) => login.handle(c.req.raw));

const caller = await login.caller(req.headers);
// → { principal, tenantId, scopeId, sub, display } | null
```

`caller()` accepts a session cookie or a bearer, so a browser and a curl script take the same
path. It deliberately does **not** decide what "nobody" means: one vertical answers 401,
another checks whether its owner seat is unclaimed and answers `needs-setup` instead. That is
policy, so it returns `null`.

`subject()` returns the issuer's answer *before* any directory lookup, for verticals whose
tenant is not the directory's to choose — a multi-venue app knows which tenant to ask about.

::: tip A proxy in front of the API must not rewrite Host
A dev server derives its OIDC `redirect_uri` from the request origin, which under a Vite
proxy is the *browser's* origin — that is what lands the callback back on your app. Setting
`changeOrigin` on that proxy sends it to the API port instead, and login breaks.
:::

## Without a browser

Tests, curl and headless verification mint tokens directly:

```sh
curl -XPOST localhost:8879/dev/token -d '{"sub":"dev|greta"}'
# → { id_token, access_token, token_type: "Bearer", expires_in }
```

This *is* impersonation, and its address is the point. It lives in a process that binds to
localhost and is never deployed, rather than behind a flag in the artifact that ships — where
the same capability reaches production and only an environment variable stands between it and
a cross-tenant hole.

## Why the key is public

A relying party verifies an ID token against the issuer's JWKS, so the issuer needs a keypair.
Generating one at boot would work, and would invalidate every session a developer holds on
every restart — along with every `/dev/token` bearer a test run is halfway through using.

So the key is **fixed**, and fixed means **public**: it is a file in a public repository, and
anyone can mint a token this issuer's JWKS will validate. That is the correct posture for a
process that binds to localhost, hands out logins by clicking a name, and is never deployed.

It is also precisely why no production relying party may be pointed at it. The trust anchor is
`packages/dev-issuer/src/keys.ts`.

## Status

Pre-release (0.x): interfaces change without notice. `hono` is a peer dependency.
