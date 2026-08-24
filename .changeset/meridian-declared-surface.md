---
'@substrat-run/demo-meridian': minor
---

Meridian declares its operation surface, and its nine list reads page

Thirteen of Meridian's checks narrow to an entity. Undeclared, they were not merely untested
but **undeclarable**: `entityCheckConformanceSuite` derives its behavioural pair from an
operation's `permission`, and twenty-seven handlers registered as `'hr/log-time': logTimeOp as
never` described nothing. To a compiler `ctx.check(HR_PERM.timeRead, employeeRef(id))` and
`ctx.check(HR_PERM.timeRead)` are the same, and the second lets anyone holding `time:read`
read every employee's timesheet. Meridian mints nine keys narrowed per employee (§4 of its
`PERMISSIONS.md`), so that is the difference between an employee seeing their own record and
seeing everyone's (#865/#891).

`src/operations.ts` declares all twenty-seven, `src/inputs.ts` and `src/schemas.ts` carry the
shapes they accept and answer, and `test/entity-checks.test.ts` drives the kit over the nine
checks it can reach. All nine were already honoured; they are now guarded rather than merely
correct today.

**Three shapes the declaration format cannot state**, named in `operations.ts` rather than
left to be inferred:

- **The conditional narrow.** `hr/list-leave-types` and `hr/list-projects` narrow when the
  caller supplies the optional `employeeId` and check the NODE otherwise. `idFrom` on an
  optional field would claim narrowing a caller omitting it does not get — the unsafe
  direction for a review artifact. They declare the bare key, which is true of the unscoped
  call and an understatement for a narrowed-grant holder. The kit does not drive them.
- **The second authority.** `hr/issue-employment-contract` opens with `employee:manage`, then
  checks `protocol:bind` and `protocol:request-signature` on the instance it mints.
  `permission` names one key; the other two are `resolved` and out of the kit's reach.
- **The caller-named entity type.** `hr/timeline` declares `entity: 'employee'` — the constant
  every call site passes, accurate to all of them and narrower than the truth. That is #890,
  and Meridian is its third instance after Callout's and Handlebar's timelines.

**Breaking at the operation seam:** declaring an operation means declaring its `output`, and a
bare-array output with no `paged` beside it is refused (#811). Nine reads now return `Page<T>`
— `hr/list-employees` and `hr/roster` kernel-composed over `employee`, the rest handler-composed
on a cursor each declaration names and the schema makes unique (`hr_leave_types.key` is the
primary key, `hr_projects.code` is `UNIQUE`, expense and request ids are ULIDs). `hr/my-expenses`
declares `order: 'desc'` to keep the newest-first order it shipped with. `hr/timeline` walks
`occurred_at`, matching Callout's timeline exactly.

Over HTTP nothing renames: a page's body is still the entries and the walk rides in a `Link`
header (#829), so the app's API client is untouched — both generic invoke routes in
`server.ts` and `worker.ts` now apply that projection.

Known seam, flagged rather than fixed: `src/api.ts` still declares each operation's summary and
input alongside `operations.ts`, because the OpenAPI catalog carries `tag`/`description` that the
operation format has no field for. Deriving the document from the declaration is #756.
