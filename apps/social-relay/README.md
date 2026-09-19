# `@substrat-run/social-relay`

The platform's social sign-in relay. It holds one OAuth client per upstream — Google,
GitHub, Apple — and serves one OpenID issuer per provider in front of them, so an
installed Auth Server can offer "Sign in with Google" without its team ever creating,
holding or rotating a provider credential (#1544).

## What it is

A tenant issuer federates to `https://id.substrat.net/google` (or `/github`, `/apple`) as
an ordinary generic OIDC upstream: discovery, `/authorize`, `/token`, JWKS, `/userinfo`.
What the install holds is its **own** client at this relay — worth nothing anywhere else,
revocable on its own, and useless for reaching any other install's sign-ins. The provider
credential is reachable only from this worker, which has no tenant-controllable config of
any kind.

## What it is not

- **Not a user store.** No accounts, no sessions, no cookie. A person who signs in through
  it leaves behind two short-lived rows and nothing else. The in-flight row that carries a
  round from `/authorize` to the callback holds no identity at all — a redirect URI, a
  state, a nonce, a PKCE challenge — and lives **ten minutes**, which is how long a person
  has to finish at the provider; abandon the round and that is how long it sits before the
  sweep. The row minted at the callback DOES hold the profile the `id_token` is about to
  carry — subject, email, name, picture — and lives **one minute**, the window the install
  has to redeem its code. Both are deleted by the read that consumes them, so the only rows
  that reach their expiry are the ones nobody came back for. Had it been a full issuer it
  would have grown a session at its own origin and become a cross-tenant SSO hub.
- **Not a UI.** `/authorize` redirects to the upstream and the callback redirects back. The
  only page it renders is an error it cannot safely redirect.
- **Not open for registration.** RFC 7591 in the open would let anyone mint a client on the
  platform's quota. `/internal/clients` is gated by `PLATFORM_SECRET`, because the platform
  is the party that knows which hostname belongs to which install.

## The honest limitation

One shared client carries one name on the consent screen, and it is the platform's. OAuth
branding is per client, so an install that needs its own name in front of its own users
brings its own credential — which the Auth Server has always supported and still does.

## Layout

| File | What |
|---|---|
| `src/routes.ts` | The whole HTTP surface; never imports `cloudflare:workers`, so tests drive it |
| `src/providers.ts` | The three upstreams and everything that differs between them |
| `src/apple.ts` | Apple's client secret, which is a freshly signed ES256 JWT every time |
| `src/jwt.ts` | ES256 signing over Web Crypto, and the small primitives around it |
| `src/store.ts` | The SQL, as pure functions — executed against a real database in the suite |
| `src/relay-do.ts` | The Durable Object that owns the registry, the in-flight state and the key |
