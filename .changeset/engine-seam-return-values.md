---
'@substrat-run/engine-workorder': minor
---

Engine return values are parsed at the seam, not just inputs

"Parse, don't trust" was enforced in one direction. Operation inputs go through Zod at the
boundary; **return values crossing the engine seam were trusted because TypeScript said
so** — and TypeScript is not there at runtime. `createWorkOrder` parsed on the way in and
returned a hand-written mapper's output; `getReportedLines` was sharper still, a
`SELECT * FROM workorder_time_entries` typed `<TimeEntry>` by assertion, so its return
shape was *whatever the table currently held*.

The failure that lets through is precise, and it is the one D-28's additive-only rule
exists to prevent: a vertical compiled against engine 0.3, running against engine 0.4,
whose row shape moved. The vertical reads a field that is now `null`, or misses one that
appeared, and the first symptom is **wrong data on a screen — not a thrown error**.

`engines/workorder/src/seam.ts` is the runtime half of that rule, and this engine is the
reference conversion:

```ts
returns(workOrder, `work order ${r.id}`, { … })   // parsed on the way OUT
`SELECT ${columnsOf(timeEntry)} FROM workorder_time_entries WHERE …`
```

- **`returns(schema, surface, value)`** parses every published value with the same schema a
  composing vertical declares its operation `output` with. The refusal is `internal`, not
  `validation_failed`: the caller's input was already parsed, so a 400 would blame the
  caller for a fault on this side — and `toProblem` drops `internal`'s detail, so the
  drift is logged rather than handed to a client that can do nothing with it.
- **`columnsOf(schema)`** derives each `SELECT` list from the schema being read, so a read
  asks for exactly the columns the seam promises. A column dropped from the table is then
  a SQL error naming it; a column added upstream is simply never read.

Two open questions the issue left, decided the boring way. **Parse always**, bulk reads
included — every read here is one row or one page (#811), and dev-only validation would be
absent exactly where the version skew lives, in production against an engine nobody in
this repo deployed. **A helper, not a convention** — one spelling, one call site per
surface, and a shape `boundary-lint` could later be taught to require.

`test/seam.test.ts` proves it by moving the tables under a running engine: dropping
`technician`, making it nullable, retyping `number`. Each one throws at the seam instead of
surfacing as wrong data, and the page walk parses every entry rather than the first read.
The other six engines are not converted; their seams are still typed by assertion.
