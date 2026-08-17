---
"@substrat-run/builder-workspace": patch
---

The build phase reads the approved model (#681, context plumbing half).

`spec/model.ts` now travels with `spec/concept.md` into every build turn,
appended to the same context block rather than threaded as a second parameter —
one seam, so the two hosts cannot drift on what a turn sees. Read from the
workspace each turn, never carried in memory: the file is the artifact of record.

The scaffold skill says what to do with it: the entity model and operation
surface are **fixed** — transcribe them, never re-derive. Entities become the DDL
and `manifestEntities`, `parents` becomes `entityRelations`, `input` is imported
rather than restated, `output` is bound with `satisfies OperationImpl`, and
`emits` uses the declared `entityIdFrom`.

And what to do when the model is wrong: say so and **stop**. A declared return a
handler cannot produce is real information, and it goes back to the model phase —
where the change is visible and approved — rather than being worked around. The
write guard already refuses the edit; this tells the generator why.

Two deliberate details:

- **Model turns do not receive the model.** That phase is writing the file;
  handing it back invites an edit-in-place loop instead of a considered
  declaration.
- **Projects that predate the model phase keep building.** No `spec/model.ts`
  means the context is the concept alone, exactly as before.

This is the plumbing half only. #681's measurable claim — that moving design
decisions into the model phase shrinks build thrash — needs the #630 eval sweep
run as an A/B, which costs real model spend and is not run here.
