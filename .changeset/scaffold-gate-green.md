---
'@substrat-run/boundary-lint': patch
'create-substrat': patch
---

A scaffolded project passes its own three gates again (scaffold checkpoint, #797).

The post-release scaffold job went red on the run that published `create-substrat@0.7.1`,
and it was right to: `npm create substrat` produced a project failing **all three** of the
gates it ships with — 4 of 9 scenario tests, 2 type errors, 1 boundary violation. Two
independent causes, neither of them the scaffolder's.

**The template never followed #811 through the paging change.** `listOrders` became
`listOrders(ctx, page): Page<WorkOrder>` — two required arguments, and a page rather than an
array — but `portalRepairsOp` still called `listOrders(ctx)` and iterated the result, and the
scenario asserted `toHaveLength` on what `invoicing/list` now returns as `{ entries }`. The
portal walk is now built on `pageVisible`, which is the helper this exact shape wants:
a permission-filtered walk must OVER-FETCH, because twenty rows read from the table can leave
three standing after the proof walk, and the cursor must advance by the last row *examined* or
the rejected rows are re-examined forever. Callout and Handlebar were migrated when #811
landed; the template is not a workspace member, so nothing in the repo compiled it and it was
left behind.

**`config-do.ts` was not in `DEFAULT_HARNESS`.** The R2 violation message advertises
*"harness code (worker.ts, `*-do.ts`)"*, but the list is literal filenames — `auth-do.ts`,
`do-contract.ts`, and no `config-do.ts`. The template ships `src/config-do.ts` (the durable half
of `/internal/configure`, and a file whose own header says it is a harness store), so **every
scaffolded project was born holding a boundary-lint violation** while the message explaining it
described the file as exempt. Its `cloudflare:workers` import is the `DurableObject` base class
workerd requires, not a reach for the ambient env that #862 added R2 to close.

The gate itself needed no change — it caught this on the first release after the breakage
existed, which is what it was built in #797 to do.
