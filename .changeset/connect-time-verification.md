---
"@substrat-run/contracts": minor
"@substrat-run/connector-scrive": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/dashboard": minor
"@substrat-run/control-plane": minor
---

feat: connecting an integration means verified, not stored — and every probe names the provider environment it asked

**The write path was still claiming more than it knew.** Upserting a credential wrote the row and
reported success; the console said "Connected", which was a statement about our own database. The
first evidence the provider disagreed arrived on the next dispatch or sweep — after a signature
request had already failed.

The relay now checks the candidate credential with the provider *before* any write:

- **Refused** (the provider answers 401/403) → `422`, and nothing is stored. The order is the
  whole point on a rotation: writing first would replace a working credential with a broken one.
  The provider's own message rides the response, so the connect dialog keeps what was typed and
  says what is wrong instead of "couldn't save".
- **Unreachable** (timeout, 5xx, DNS) → stored, reported unverified. Deliberately *not* a refusal:
  rejecting during a provider outage would make it look like every tenant's keys had gone bad, and
  would block the rotation someone is attempting because things are broken. `ConnectionProbe.refused`
  is what separates a provider speaking about the credential from a provider that did not answer.
- **Accepted** → stored, and the successful pre-flight is recorded as health, so a just-verified
  connection reads "last used just now" rather than "connected, not used yet" — the same empty
  claim in different words.

Both write paths get the gate: the dashboard's connect and a vertical's own admin screen through
`/internal/connections/upsert`. A provider with no candidate probe registered behaves exactly as
before — the check is available, never assumed.

`probeScriveSecret` tests a secret that is not stored yet (no connection opened, no health written
against the live one), and `ScriveApiError` carries the HTTP status so a 401 is *classified* rather
than inferred from a message string.

**Every probe also names the environment it asked.** A production credential sent to Scrive's
testbed returns 401 — byte-for-byte what a mistyped key returns — so a verify result that does not
say which Scrive it called sends an operator to check the wrong thing. It is now the first fact on
both the success and the failure answer: `production (scrive.com)`, `testbed (api-testbed.scrive.com)`,
or the bare host.
