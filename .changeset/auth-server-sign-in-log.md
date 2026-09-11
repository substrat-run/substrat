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
