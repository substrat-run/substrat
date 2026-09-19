---
'@substrat-run/control-plane-api': patch
---

`mapError`'s `CODE_PATTERNS` table loses its `unknown version` row — 22 rows to 21 (#113 phase 5). Both adapters now throw that refusal typed, so the code is read from the declaration one branch earlier and the row had nothing left to match. The response is unchanged — same 404, same detail — and every other row in the table is untouched. The row could only go after the throws were typed: an untyped `unknown version` now falls through to the generic 500, which is the point, and a new case pins both halves.

The table's header now also records what decides whether a row CAN go, so the next person does not have to re-derive it: the throws must live on the COORDINATOR. A `substratError` raised inside a Durable Object — `scope-do.ts` or `control-plane-do.ts` — arrives here as a plain `Error` whose message has grown a `Substrat.<code>: ` prefix, because workerd folds `name` into the message and resets it. Typing a DO-side throw today therefore loses the code *and* rewrites the sentence, and roughly half the remaining rows are waiting on the `{ ok, error }` envelope rather than on attention.
