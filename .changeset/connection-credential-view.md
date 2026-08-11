---
"@substrat-run/contracts": minor
"@substrat-run/connector-scrive": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/dashboard": minor
"@substrat-run/control-plane": minor
---

feat: the Integrations detail actually tells you something — which credential is loaded, and the provider's own archive (not just what we sent)

Three gaps left by #605's first pass, all found by using the screen:

**"Manage" opened an empty form.** On the account-level Integrations page, a connected provider's
primary button still went to the connect dialog with four blank fields — which reads as "your
credentials are gone". It now opens the detail; rotating is one click further in, where replacing
a credential belongs.

**Nothing showed which credential was loaded.** The store's write-only rule is right, but with no
view at all "connected" and "connected with a mistyped token" looked identical, and the only
repair on offer was to paste all four fields again blind. `GET /tenants/:t/connections/:id/credential`
now answers a reduced view, produced by the connector — the only party that knows which of its
fields are identifiers (Scrive's own UI calls two of the four "credentials identifier") and which
are secrets. Identifiers come back whole; secrets come back as a bullet run plus their last four
characters, and anything shorter than eight characters is masked entirely rather than mostly
revealed. Enough to tell two credentials apart by eye, never enough to sign a request. There is
still no reveal and no edit-in-place: replacing a credential is rotation.

**Activity only showed our own dispatches.** The ledger is complete for what this platform sent
and blind to everything else in the provider account — including documents someone created in
Scrive's own UI, and anything sent before the connection existed. `GET …/activity?source=provider`
lists the provider's archive instead, marking which rows came from this app (via the
`substrat_instance` tag the connector already sets). Neither view is a superset of the other, so
`source` travels in the answer, and the detail view offers both. Unlike the ledger read, the
provider read refuses rather than degrading on a provider failure: an empty list would read as
"the account is empty", which is a lie an operator would act on.

The honesty banner and page subtitle now say what is actually true about what a console can see.
