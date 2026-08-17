# @substrat-run/engine-absence

## 0.2.1

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.2.0

### Minor Changes

- eddd3c5: The last three engines declare their entities. All seven now have registries.

  A vertical composing any of them can name its entity types in a checked relation
  edge, and declare an operation's `output` against a real schema instead of
  retyping the engine's shape.

  Each surfaced a different shape, which is why they were worth doing rather than
  assuming:

  **booking has TWO entities and the first parent edge INSIDE an engine.** Everywhere
  else the parent is the vertical's noun, so engine registries declare none — but a
  reservation cannot exist without the resource it reserves, and that is true in
  every vertical. `booking_participants` stays out: a join row, not an entity.

  **invites has a row-versus-published split, for privacy.** `identifier_hash` is
  stored and deliberately never published — hashing the invitee's identifier is
  pointless if the row is returned. So the registry describes the row (what the
  journal comparison checks), `invitationRow` is that, and `invitation` is the
  projection an operation may return. It is also declared `erasable`: destroying
  the hash is what unlinks an invitation from the person.

  **absence has the same split for a duller reason** — SQLite has no boolean, so the
  row stores `active` as 0/1 while `LeaveType` publishes a boolean in camelCase.
  Its ledger and requests are rows the engine owns; only the leave TYPE is
  something the platform points at.

  That is three engines in a row where the stored row and the published type differ,
  after `engine-workorder` made the same distinction. A vertical wants the published
  one for an operation's `output`, and each engine now says which is which.

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.1.3

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/kernel@0.68.0

## 0.1.2

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0

## 0.1.1

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/contracts@0.66.0

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
