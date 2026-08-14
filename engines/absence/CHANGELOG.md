# @substrat-run/engine-absence

## 0.1.0

### Minor Changes

- 49e8ede: `engine-absence` v0 (#634): the approved-absence ledger, extracted from
  Meridian per its spec's own plan (§5/§5.1) when consumer #2 — Egeryds route
  resource planning — arrived. The engine owns the append-only entry ledger over
  an opaque subject `EntityRef` + vertical-supplied `DataSubjectId`, balance as a
  pure fold, a per-leave-type balance floor (negative floor = förskottssemester),
  the request → approve|reject → cancelled state machine as the only mint for
  `booking`/`reversal` entries, a coverage-only `availability()` read, and the
  #383 stale-request expiry schedule. Leave-type vocabulary, accrual formulas,
  weekends/red days and holiday calendars stay vertical, by design
  (`docs/design/engine-absence.md`; the entry ledger is deliberately
  engine-private, not a kernel primitive — D-A).

  Meridian adopts it in the same change: `0003-absence-to-engine` R5 extraction
  handoff moves `hr_absence_ledger`/`hr_leave_requests` into the engine's tables
  (subject = the `('employee', id)` ref, `data_subject_id` = the employee id the
  hr.\* spine already shreds on), the absence operations become compositions of
  the engine's in-scope exports behind the unchanged HTTP surface, and the
  `absence:*` permission keys — same strings as ever — are now declared by the
  engine. The absence events move to the engine's `absence.*` vocabulary, and
  stale-leave expiry is attributed to `{ system: '@substrat-run/engine-absence' }`.
