---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
---

The findings read pages (#2198).

`listFindings` takes a `cursor` beside `limit` and walks `lastSeen` descending with `id` ascending as the tiebreak, so a team with more than 100 findings reaches the older ones. A read that sends neither is unchanged: the same 100 rows in the same order. `GET /findings` answers `{ entries, nextCursor }` (an added field), accepts `cursor`, and refuses a `limit` outside 1–500 or a cursor it did not mint with a 400 instead of reading it as "from the start".

- contracts: `FINDINGS_LIMIT_DEFAULT`, `FINDINGS_LIMIT_MAX`, `findingCursorOf` and `parseFindingCursor`; `FindingFilter` gains `cursor`.
- kernel: `listFindings` refuses a `limit` over `FINDINGS_LIMIT_MAX` (it accepted any positive number before; the HTTP route already stopped at 500).
- contract-tests: the findings suite walks a tenant by cursor on both adapters.
- kernel: `observeFinding` stores `first_seen` / `last_seen` in the canonical instant form (`toISOString`), the spelling a cursor is minted in, and refuses an `at` that is not an instant. Every in-repo writer already stamped that form.
