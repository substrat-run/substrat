---
'@substrat-run/engine-booking': patch
---

The booking seam is parsed, not asserted (#771)

Every resource, reservation, participant and free interval this engine publishes is now `.parse`d by the schema it publishes on the way OUT — the same schema a composing vertical declares its operation `output` with — and every read names its columns instead of `SELECT *`. A stored row that no longer matches the published shape (a column retyped, dropped or made nullable by a later engine version under a vertical compiled against an earlier one) is an `internal` throw at the seam rather than wrong data on a screen; a column added upstream never crosses it. Behaviour-preserving for every row that matches, which is every row a released migration produces. Same mechanism as `engines/workorder` (`src/seam.ts`).
