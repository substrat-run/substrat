---
'@substrat-run/demo-auth-server': patch
---

A client restricted to one sign-in provider can be signed into again (#1381).

`metadata.signIn = { providers: ['<upstream>'], password: false }` was unusable:
the person was sent to the upstream, came back, and was sent there again —
forever, resting on `/api/auth/callback/<provider>` between hops. A directory
that worked perfectly, looping.

The two halves of the feature were disagreeing about one string. Enforcement
compares the client's policy against `session.signInProvider`, stamped at session
creation from the path the session was minted on — and Better Auth hands that hook
the ROUTE, not the URL. Its social callback is registered as the literal
`/callback/:id`, with the provider in `params.id` beside it, so reading the id out
of the path stamped `null` on every provider sign-in. A `null` stamp is refused
under every policy, deliberately, because that is the fail-closed answer for a
session that predates the feature. So `/oauth2/authorize` refused the session with
`max_age=0`, the plugin returned the person to `/login`, and the login screen —
narrowed to one provider with no password beside it — started the same trip again.
Password sign-in was unaffected: `/sign-in/email` is a literal route with no
parameter to lose.

`signInMethodOfPath` now resolves the parameter when the matched segment is a
pattern, and parses what comes back with the same rule a provider id is
constrained by, so only an id-shaped value can become a stamp. Nothing else
changes: an unparameterized route still reads as itself, the reserved ids
(`password`, `bankid`) are still refused from a callback, and an unstamped session
is still refused under every policy.

The suite gained the case that was missing rather than the case that failed. Every
existing test established its session with a password and proved a REFUSAL, and a
refusal only needs the stamp to be absent — so all of them passed over an
implementation that stamped nothing. Three cases now drive the real callback: the
stamp says the provider, a client naming that provider is handed on to consent,
and the same session is still refused by a client naming a different one.
