# @substrat-run/engine-absence

## 0.3.2

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/contracts@0.75.0

## 0.3.1

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.3.0

### Minor Changes

- 3b8533d: **zod is now a peer dependency.** Install it alongside these packages:

  ```sh
  npm install zod@^4.4.0
  ```

  Every package here hands out zod schemas that a consumer parses with, composes
  into their own, and that `mountOperations` reads `_zod.def` off to find pinned
  literals. Two copies of zod in one tree means an object made by one is not
  recognised by the other, and the symptom — `expected a Zod schema` — points
  nowhere near the cause. A peer dependency says _use the consumer's copy_.

  The declared range is `^4.4.0` rather than the exact version this repo builds
  against: a peer range should state what the code supports, and pinning it to
  `^4.4.3` would refuse a consumer on 4.4.0 for no reason.

  **A defect this found.** `@substrat-run/contract-tests` shipped **130
  `import("zod")` references in its published `.d.ts` while declaring zod
  nowhere.** It resolved only because contracts had zod as a regular dependency,
  which hoisted a copy into view — not a dependency, a coincidence. It now declares
  it. Two more of the same class turned up when the tree shifted: packages using
  `setTimeout`/`atob`/`btoa` — globals absent from `lib: ES2023` — compiling on an
  ambient `@types/node` nobody had declared.

  That is the general rule now enforced by `pnpm lint:deps`
  (`tools/declared-deps.mjs`) in CI: **every module a package references, in its
  source or its emitted `.d.ts`, must be one it declared.** The `.d.ts` half is the
  sharp one — TypeScript writes the original specifier into declarations however
  the source imported it, so re-exporting `z` through contracts still emits
  `import("zod")` into a dependent's types.

  **Why a lint rather than pnpm's own enforcement**, measured rather than assumed:
  `autoInstallPeers` (pnpm's default) turns a peer conflict into a silent second
  copy — with contracts peer-requiring `^4.4.3` and a consumer declaring `^3.23.0`,
  pnpm reported nothing, and `zod` did not appear once in the peer report even
  under `--strict-peer-dependencies`. And pnpm's peer checking does not reach
  `workspace:` links at all. Full reasoning in `docs/architecture/dependency-policy.md`.

  Internally, shared versions now come from a pnpm `catalog:` so one version is a
  single edit. The `pnpm` settings block moved from `package.json` to
  `pnpm-workspace.yaml`, which is where pnpm 10 reads it — it had been ignored,
  with `overrides` surviving only because they were baked into the lockfile.

  Closes #742.

### Patch Changes

- Updated dependencies [3b8533d]
  - @substrat-run/contracts@0.73.0
  - @substrat-run/kernel@0.73.0

## 0.2.3

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/kernel@0.72.0
  - @substrat-run/contracts@0.72.0

## 0.2.2

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/kernel@0.71.0

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
  (`docs/engines/absence.md`; the entry ledger is deliberately
  engine-private, not a kernel primitive — D-A).

  Meridian adopts it in the same change: `0003-absence-to-engine` R5 extraction
  handoff moves `hr_absence_ledger`/`hr_leave_requests` into the engine's tables
  (subject = the `('employee', id)` ref, `data_subject_id` = the employee id the
  hr.\* spine already shreds on), the absence operations become compositions of
  the engine's in-scope exports behind the unchanged HTTP surface, and the
  `absence:*` permission keys — same strings as ever — are now declared by the
  engine. The absence events move to the engine's `absence.*` vocabulary, and
  stale-leave expiry is attributed to `{ system: '@substrat-run/engine-absence' }`.
