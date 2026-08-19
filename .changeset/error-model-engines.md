---
'@substrat-run/engine-absence': minor
'@substrat-run/engine-booking': minor
'@substrat-run/engine-invites': minor
'@substrat-run/engine-invoicing': minor
'@substrat-run/engine-metering': minor
'@substrat-run/engine-protocol': minor
'@substrat-run/engine-workorder': minor
---

The error model, phase 2b: every engine refusal now says what kind of refusal it is.

All 78 `throw new Error(…)` sites across the seven engines carry a taxonomy code —
`not_found` for a missing entity, `conflict` for a refused state machine or a broken
invariant, `validation_failed` for malformed input, and `internal` for the two that mean
corrupt state rather than a caller mistake (`ledger integrity violated`, `signed protocol
has no primary signature`).

**Not one message changed.** That is the point, and it is what let 78 sites convert
without touching a single assertion anywhere else: the demo scenarios, the contract
suite and every regex-matching transport still see the exact strings they saw before.
The code rides alongside, for whoever asks.

Why the engines went first: transports reading `code` only pays off if throws carry one,
and before this exactly ten did. Every conflict, every not-found and every immutability
violation in the repo was a bare `Error`, so pointing the transports at `code` would have
found nothing and left their regex tables permanently un-deletable. Engines are also the
highest value per edit — their throws ARE the invariants, they are the stable surface
verticals compose against (D-28), and "the state machine refused" is exactly the class
message-matching guesses at and frequently misses.

No `reason` slugs yet. The taxonomy lets a module narrow a code with a reason it owns,
but inventing 78 of them is a design exercise per site with no consumer asking; adding
one later is additive. Codes now, reasons when something needs to branch.

Still bare, deliberately: the ~30 kernel and adapter throws the control plane's
`STATUS_PATTERNS` already matches (`already taken`, `illegal scope transition`, `not
active`, `unknown tenant/scope/table`). Those are next, and they are the ones that make
those regex patterns deletable. The remaining ~237 kernel/adapter throws are genuinely
`internal` and should stay as they are.
