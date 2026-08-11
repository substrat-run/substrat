---
"@substrat-run/contracts": minor
"@substrat-run/connector-scrive": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/dashboard": minor
"@substrat-run/control-plane": minor
---

feat: an integration becomes something you can interrogate — verify a credential against the provider, and read what the connection has actually done

Connecting Scrive was a leap of faith. The stored credential was never checked (a typo surfaced
days later as a failed signing dispatch), and afterwards the only trace of an outbound call was
health — one line, last-write-wins — because `openConnection` is deliberately unaudited: a row
per outbound HTTP call would drown the log that matters. Everything else lived in the platform
worker's logs, which a tenant cannot see.

Two provider-agnostic reads close that. `POST /tenants/:t/connections/:id/verify` asks the
provider to accept the credential right now and answers whose account it is; a refused key is a
`200 { ok: false, error }` carrying the provider's own words, because "this feature is disabled"
and "invalid credentials" send an operator to different places. `GET …/activity` serves the
connector's dispatch ledger — the only durable record that a call ever happened — with `?live=1`
joining the provider's current state, and a `live` flag so a console never presents the platform's
record as the provider's truth.

Both dispatch through host-injected `connectionInspectors`, keyed by provider (the `sweepers`
idiom), so `control-plane-api` still imports no connector and an unwired provider 501s honestly.
The activity view is the connector's own **projection**, never a raw ledger row: Scrive's rows
carry the callback capability token, so redaction is structural rather than remembered.

The Scrive connector gains `getProfile` and `listDocuments` (both verified against the live
testbed — `/api/v2/getprofile`, not `/api/v2/user/getprofile`), `probeScriveConnection`, and
`scriveConnectionActivity`. The dashboard's Integrations surfaces get a Details view: health,
the live grants the connection holds (the readable blast radius), the activity list, and a
Test connection action. Verifying is itself a use, so it refreshes health too.
