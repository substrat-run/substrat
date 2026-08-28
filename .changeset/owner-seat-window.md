---
'@substrat-run/vertical-auth': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contracts': minor
'@substrat-run/dashboard': patch
'@substrat-run/demo-ticket0': patch
'@substrat-run/demo-meridian': patch
'@substrat-run/demo-manyfold': patch
'@substrat-run/demo-callout': patch
---

The owner seat is claimed by whoever signs in first — for fifteen minutes, and then by a claim link (#925)

A hosted vertical's owner seat is minted empty at provision and bound to a human by the first
verified subject to arrive. That is the right trade in the install flow, where the installer
opens the app seconds later. It was the wrong trade everywhere else: the window was unbounded
in time and in audience, so a CI-deployed instance whose issuer had open sign-up sat as a seat
anyone could take, indefinitely — and nothing anywhere said it was open. A re-provision made
it worse: `INSERT OR REPLACE` re-minted the pending seat on every reconcile, so a sweep could
hand a claimed desk's ownership to the next stranger to sign in.

**`@substrat-run/vertical-auth`** — the rules now live in `owner-seat.ts`, unit-tested over a
real SQLite. The first-sign-in claim closes `FIRST_SIGN_IN_WINDOW_MS` (15 min) after provision;
a seat from before the column existed reads as closed. The seat then stays pending — `needsSetup`
keeps saying so, and the new `ownerSeat` says *why* — until a claim binds it. `mintOwnerClaim` /
`claimOwner` are the claim link (only the token's hash is stored; minting again retires the
earlier link), and `mintOwnerClaimLink` does token + hash + URL in one call. A re-provision
keeps the window it has and never re-opens a claimed seat.

**`@substrat-run/vertical-host`** — two flavored routes, `GET /internal/owner-seat` and
`POST /internal/owner-claim`, over the `ownerSeat` / `mintOwnerClaim` hooks (501 without them),
parsed on the way out as well as in. **`@substrat-run/contracts`** — the `ownerSeat` and
`ownerClaimLink` shapes. **`@substrat-run/control-plane-api`** — `GET …/owner-seat` and
`POST …/owner-claim` per scope, with the link's origin taken from the platform's own hostname
directory (canonical `app` first), never from a body.

**Dashboard** — an *Owner seat* card on the app's Overview: claimed, unclaimed with the window
still open (pulsing — open it now), or unclaimed and closed, with a *Get claim link* button.
The link is shown once and stored nowhere.

**The four verticals on vertical-auth** (callout, meridian, manyfold, ticket0) — `/api/me`'s
`needs-setup` answer now carries `firstSignInOpen`, the SPAs say which way in applies instead
of offering a sign-in that binds nobody, and `?claim=<token>` → `POST /api/claim-owner` is the
counterpart of the invite flow.

Not built: binding from the projected identity links (#406). The dashboard links identities
under the platform's own pool, and a hosted app's issuer is always an external one or a team
Auth Server — so no link would ever match, and matching on `sub` alone would be the cross-pool
bind the issue warns against.
