---
'@substrat-run/connector-scrive': patch
---

`ScriveMock` applied the delivery rule to the author, which the real Scrive does not — correcting
what `0.8.0` claimed about what can start

`0.8.0` said *"no party carries an address, so the real Scrive refuses every document this
connector builds"*. Not accurate, and the inaccurate half is the dangerous one. Production started
a document — Scrive `9222115557586247373`, from the Egeryds scope — and the connector's own ledger
proves it: `create` has exactly one `putConnectorState` and it sits after `await api.start()`, so a
ledger row means `start` returned 2xx.

The error text says which participant it means: *"Invitation delivery for **participant #2**
requires valid email field."* Participant #1 is the author, and Scrive never invites the author —
it is the sending account. So the missing carrier (#687 item 1) splits in two, and only one half is
loud:

| party set | outcome |
|---|---|
| a real counterparty to invite | refused at `start` — visible, retried, journalled |
| only the author | **starts, journals a document id, reports `sent for signature`, delivers to nobody** |

The second row is reachable without anyone choosing it. `requestSignatures` resolves the issuing
party unconditionally — the declared one, else the **first** — so a caller naming only `counter`
parties has one of them silently made the issuer, and this connector maps `primary` to
`is_author`. That is how production got there.

`ScriveMock.strictDelivery` now exempts the author, because the rule it was applying to every party
refused the one case that must not be refused and hid the case that actually hurts. Both rows are
asserted in `test/dispatch.test.ts`: the refusal names participant #2, and the control case asserts
today's silent start — so closing it is a deliberate edit rather than a test that quietly goes
green. A `contact` field alone will not close it: an author is uninvitable whatever address it
carries, so #687 item 1 needs the companion invariant that no document goes out with nobody to
deliver to.

No behaviour change in the connector itself; the mock, the README caveat, and the tests are what
move.
