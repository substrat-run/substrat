---
'@substrat-run/demo-auth-server': patch
'@substrat-run/demo-auth-server-app': patch
---

The issuer remembers what happened when someone tried to sign in.

"A user cannot sign in with Microsoft" was a question this issuer had no way to answer.
Every fact that would have settled it was destroyed as it was produced: a refused
federated sign-in reports itself by REDIRECTING, so the reason existed only as a query
parameter on somebody else's screen; the authority the issuer addressed on that person's
behalf existed only in an address bar, mid-navigation; and a hosted install is a script in
the platform's dispatch namespace, whose `console.log` is not somewhere the operator who
configured the provider can look. So the answer went where that operator already is — the
issuer's own SQLite, which is what the admin console reads, what the dashboard's Data tab
shows, and what `/internal/export` dumps.

`sign_in_attempt` records both ENDS of a round trip, one row per hop, and the pair is the
diagnosis. `started` says the person was handed an authorization URL and names the
authority they were sent to. `succeeded` / `failed` says what came back, carrying the
refusal code and — the field that is usually the whole answer — the upstream's own
sentence about it, because an `AADSTS…` message names the exact misconfiguration. A
`started` row with nothing after it is itself the most telling shape there is: the person
never returned, so the refusal happened on the provider's own screen, and the authority is
then the only evidence available. `common` against a single-tenant app registration fails
exactly that way, and the log is now the one place that distinction is visible.

It is written from an after-hook, which is the only place either end is observable:
`/callback/:id` signals every outcome it has — success and refusal alike — by THROWING a
redirect, so the outcome is read off that redirect's `location` and not from a return
value that does not exist. A hook written against the return value would log nothing on
the paths that matter and pass its own tests, which is why the suite drives a real round
trip for each.

No credential can reach a row. The writer takes a fixed, narrow set of fields — nothing
arrives by spread — and of the authorization URL it keeps only the part before the `?`:
the query is where the PKCE challenge, the state and the signed authorize request live. A
log of sign-in attempts that leaked the material of one would be worse than the problem it
was added for, so that rule is held at the write, and a test asserts the property over
every stored cell rather than over the fields it happens to know about.

The table is a RING, pruned on write to the most recent 500 hops: this is a debugging aid
in a Durable Object's SQLite, not an audit trail, and the screen says so instead of
implying the log is complete. The writer swallows its own errors for the same reason — a
debugging aid must never be the thing that costs someone a login.

`GET /api/admin/sign-in-log` reads it behind the same session + `admin` gate as its
neighbours, paging by id rather than by offset because the ring moves underneath a reader.
On screen it is a new **Sign-in log** section beside the providers it explains, with a
"Refusals only" filter, since that is the read an operator actually makes.

No migration to review and no new permission key. Passwords and BankID are not recorded:
what went missing was the federated round trip, and a narrower table is a smaller amount
of somebody's sign-in activity to hold.

## And the spinner that never resolved

A stuck screen is not a refusal, so the log above would not have explained one. Two reads
gate every screen this app has — `/api/setup-state` and `/api/session` — and both trusted
whatever came back: `res.json()`, no status check, no shape check, called from a `refresh()`
with no `catch` and five bare `void refresh()` callers. Both failure shapes a deployed
issuer actually produces ended somewhere worse than an error message.

A body that is not JSON — a worker exception page, a 5xx from an intermediary, anything
HTML — made `res.json()` reject inside that un-caught `refresh()`. The phase stayed
`loading`, so the page said “Loading…” and meant “this failed seconds ago and nobody is
going to tell you”. That is the shape a person reports as being stuck on a spinner.

An `{ error }` envelope — which is exactly what `routes.ts` answers a failure with — parsed
perfectly well and was handed on as data. As a session it is a truthy object with no
`role`, so the console told an administrator they were not one. As the issuer state it left
`providers` undefined for a screen whose next line is `providers.length`.

Both reads now go through `app/src/wire.ts`, which checks the status, reads the body as text
so a non-JSON answer becomes “the issuer answered 502” rather than a parser error, lifts the
issuer's own `error` message when there is one, and refuses a body that parses but is the
wrong shape. It is React-free and `fetch`-free for the reason `paths.ts` is, so the issuer's
own vitest pins all of it.

The distinction the tests care about most: a failed session read must never be reported as
“signed out”. Signing out someone who is signed in sends them to a login screen — and for a
client restricted to one provider, that screen redirects straight back out to it, so the
cheap answer turns one failed read into a loop through a working directory.

`refresh()` now has one wrapper every caller goes through, and a rejection is a screen: the
reason, the fact that it is the issuer's problem rather than the person's, and a Try again
button. `clientOptions` is deliberately left alone — a theme and a sign-in narrowing have an
honest fallback in the issuer's own defaults, so that read degrades rather than failing.
These two have no fallback; there is no honest “probably signed in”.

## From review

Three things the first cut got wrong, all worth the fix:

**The two halves of one attempt were not joined.** "A hop out with nothing after it means they
never came back" is an inference over two rows, and two people signing in at once is all it takes
to break it: `started, started, succeeded` says nothing about which of them is still missing — so
the inference the table exists to support would have been wrong exactly when the issuer was busy.
The rows now carry a `correlation`, derived independently at both ends from the OAuth `state`,
which is the only thing that survives the round trip. Hashed, truncated to 64 bits, never stored
raw: the state is what the callback checks the returning request against, so a log holding it in
plaintext would be a log of live single-use tokens — the exact class of thing this table refuses
to carry. The screen uses it to mark an unanswered hop itself rather than asking a reader to pair
rows up by eye.

**The failed screen printed the issuer's own error text.** That screen is pre-auth and themed as
whichever relying party sent the person there, so its reader is a stranger signing into somebody
else's app — and `routes.ts` answers a failure with the raw `.message` of whatever threw inside
the issuer. `IssuerUnreachable` now carries the two apart: a generic `message` with the status for
the page, the issuer's own words in `detail`, which `App.tsx` logs to the console and never
renders.

**The screen claimed to page and did not.** The read was keyset-paged server-side and the view
only ever asked for the newest page, so on a busy issuer the older four-fifths of the ring were
unreachable from the one screen built to read it. There is now a Load older control, keyed on the
oldest row's id — keyset rather than offset, for the reason the server is: the ring is pruned
under a reader and an offset steps over whatever moved.

