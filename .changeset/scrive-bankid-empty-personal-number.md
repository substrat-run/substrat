---
'@substrat-run/connector-scrive': minor
---

`authLevel: 'strong'` dispatches instead of being refused: Scrive's BankID auth-to-sign wants the
`personal_number` **field**, not a value

`0.7.0` refused `strong` before egress, reasoning that Scrive requires a personnummer on the party
and Substrat may carry none (design rule B6). Probed against the testbed (#687): a party carrying
`personal_number: ''` draws exactly the same `start` errors as one carrying a real personnummer,
and a party carrying no such field draws `invalid_authentication_to_sign_info` on top of them. So
`ScriveApi.update` now sends an empty `personal_number` for every `se_bankid` party — the signatory
completes it during the BankID ceremony — and `scriveAuthMethod` maps `strong` straight through.
No PII carrier is needed for the auth level.

Also: a refused `start` reports several reasons at once, and `asJson` surfaced only the first, so
fixing one problem revealed the next one delivery at a time. All of `error_details.explanations` is
now joined into the message an operator reads through the delivery-attempt history (#618).

`ScriveMock` learned the `start` rules the testbed enforces — a `se_bankid` party with no
`personal_number` field is refused with Scrive's own error envelope — and gained
`strictDelivery`, which adds the rule the connector still cannot satisfy: **no party carries an
address**, so every document it builds is refused with `invalid_invitation_delivery_info`, at
`basic` as much as at `strong`. That is #687 item 1 and this release does not fix it; it is
asserted in `test/dispatch.test.ts` so it fails loudly when a contact carrier lands.

`test/live.test.ts` now covers `start` — the call the suite never made, and the only place the
production 409 ever lived.
