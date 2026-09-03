# @substrat-run/connector-fortnox

## 0.3.0

### Minor Changes

- 067915b: Fortnox: read SIE4 as PC8/CP437, and tolerate the nulls a real company sends

  The first live run against a real Fortnox company disproved two claims this connector
  had been carrying on documentation alone.

  **The SIE4 export is PC8 (code page 437), not ISO-8859-1.** The file declares it in
  `#FORMAT`; the HTTP response does not. Decoding it as latin1 does not throw and produces
  no replacement character — every byte 0x00–0xFF is a valid latin1 code point — so every
  Swedish letter in every account name came back wrong, silently: `för` arrived as `f”r`.
  The whole package stayed green through this because `FortnoxMock` encoded latin1 too, so
  the reader and the fixture agreed with each other while both disagreed with Fortnox.

  Decoding now lives in `decodeSie`, which reads `#FORMAT` and refuses a charset it does
  not implement rather than guessing. `TextDecoder` is no help here: CP437 is not in the
  WHATWG Encoding registry, and `TextDecoder('iso-8859-1')` is really windows-1252, which
  differs from latin1 in exactly the range CP437 keeps its Swedish letters in — so the
  decoder carries its own table for 0x80–0xFF.

  **`companyinformation` sends explicit `null` for unset text.** `.optional()` permits an
  absent key, not a null one, so the response parse threw for any company with a blank
  address — which would have broken the connect-time probe rather than the sweep, i.e. at
  exactly the moment an operator is trying to verify a new connection. Text fields are now
  null-tolerant, and `DatabaseNumber` normalizes null to undefined because callers test
  `=== undefined` before stringifying it, and `String(null)` is the tenant id `"null"`.

  **Breaking:** `latin1Bytes` is now `pc8Bytes` and encodes CP437. Anything building SIE
  fixtures against the mock encodes the way Fortnox actually does.

  Also adds `pnpm fortnox:seed`, which puts a financial year and balanced vouchers into a
  sandbox so the live suite has something to read. It refuses to write to any company whose
  organisation number is not Fortnox's sandbox marker `555555-5555`: the live suite is
  read-only by design, which is what makes it safe to point at production books, and the
  writing must never move into it.

### Patch Changes

- Updated dependencies [551d0cf]
  - @substrat-run/contracts@0.98.1
  - @substrat-run/kernel@0.98.1

## 0.2.0

### Minor Changes

- 6724512: A Fortnox connector — the first **inbound** one, and the first with no event behind it.

  Every connector so far answers an event: a vertical does something, an engine emits, the connector effects it outside. Accounting runs the other way. Nobody inside a scope asks for last month's bookkeeping the way they ask for a signature; the books change at Fortnox, and the platform finds out by looking. So this connector registers no handler at all. `sweepFortnoxLedger` is a `ConnectorSweeper`, the deployment binds it into the platform sweeper beside Scrive's, and that is the whole trigger surface.

  **The credential is client-credentials, not the authorization-code flow, and that removes a whole class of failure.** Fortnox's refresh tokens are single-use and rotating: two concurrent refreshes race, one wins, the other saves an already-dead token, and the connection is bricked until a human reconnects it. Integrations built that way all end up carrying the same three mitigations — coalescing concurrent refreshes per company, optimistic locking on the token write, a distinct "reconnect" error. Fortnox also supports `grant_type=client_credentials` against a _service_ consent, where an access token is minted on demand from three static values (`clientId`, `clientSecret`, and the company's numeric `DatabaseNumber` as a `TenantId` header) and no refresh token exists. There is no rotating state, so there is no race, no coalescing map, no token table. The cost is a one-time browser consent per company with `account_type=service`; `fortnoxConsentUrl` builds that URL and always sets it.

  **What replaces the event is a binding, and it is verified when it is made.** A sweep has no delivered event, so it has neither a scope to write to nor authority to write with — Scrive gets both from the ledger row it wrote when the event arrived. `bindFortnoxScope` declares them once: which scope, which operation the ledger lands through, which permission that operation checks. It **refuses when the connection does not hold that permission on that scope**, which is the point: without the check the binding is written and the missing grant surfaces on the next sweep, in a background timer nobody is watching, after a year of bookkeeping has already been fetched. That is the shape of #841. `FORTNOX_CONNECTION_GRANTS` is therefore empty rather than absent — the permission belongs to the consuming vertical and cannot be named at this package's build time, so the check moved from build time to bind time rather than disappearing.

  **The connector hands you neutral accounting fact and stops.** A `FortnoxLedgerPage` carries accounts, cost centres, months and debit-positive sums. What a business _means_ by them — which account is `lokal_grundhyra`, which sign normalizes it, which group it rolls into — is vocabulary, and vocabulary is the vertical's layer. A connector that mapped account numbers to row keys would be a vertical wearing a connector's clothes, and the second customer with a different chart of accounts would have to fork it.

  Reading is one SIE4 export per financial year rather than a walk of per-voucher endpoints, and the format carries four traps that produce wrong data rather than an error, each of which is handled and pinned by a test: the response is **ISO-8859-1** and decoding it as UTF-8 silently mangles every å/ä/ö into a corrupted ledger that looks like a working one; the financial year must be picked by **overlap, not containment**, because a newly-acquired company's first year can start mid-month and a containment search reports empty books; amounts are **debit-positive** and are deliberately not normalized here; and `#IB`/`#UB`/`#RES` are the balances the vouchers already sum to, so including them doubles every figure. Cost centres come free — SIE reserves dimension 1 for kostnadsställe, so a per-property breakdown needs no extra call.

  A pass hashes the SIE payload **together with the requested window** before landing anything, so an unchanged year costs no `invoke` at all while a different window is still a different sync — what lands is the payload filtered to the window, so hashing the payload alone would let a January sweep of a July-to-June financial year skip the months a December sweep never covered. The cursor is written only after every page lands, so a mid-way failure retries the whole year instead of resuming into a half-written ledger; and the `syncId` **is** that hash, so every page of one run shares it and a redelivered page cannot double a balance.

  Ships at `0.x` because it is unverified against a real company: `FortnoxMock` is the author's reading of the documentation on both sides of the call, and three claims still rest on that reading — that client-credentials minting works as described, that SIE4 really is latin1, and that the response envelopes are `FinancialYears`/`CompanyInformation`. `test/live.test.ts` checks all three against the real API and skips until a credential is present. It reads only: the data calls are GETs and the one POST is the token mint, which creates no Fortnox record. This connector has no write path to Fortnox at all, so it is safe to run against production books.

### Patch Changes

- Updated dependencies [05de166]
- Updated dependencies [07203fb]
- Updated dependencies [ee70af5]
  - @substrat-run/contracts@0.98.0
  - @substrat-run/kernel@0.98.0
