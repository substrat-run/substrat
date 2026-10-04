---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

The kernel ships the membership executor (#1184): `registerMembershipExecutor(host, { actor, level })` consumes the `member.add-requested` event `@substrat-run/engine-invites` emits on accept, and effects the org membership and the invited role at the scope or the tenant node.

- Nothing in the payload is taken as authority. The inviter is the kernel-stamped actor of the invitation's `invites.sent` event, and the role is assigned only if that inviter still holds every permission it carries at that node, when the event is executed: the `ctx.canAssign` comparison. A sender demoted or removed between send and accept is refused, and so is a request naming another tenant, a joiner other than the one who accepted, a role the invitation was not sent for, or an invitation somebody else accepted first.
- The admin rows are written by the given platform actor, `onBehalfOf` the inviter, with `causedBy` the event id: the correlation id that joins the scope's half of the trail to the directory's.
- An executor handler receives a third argument, `ExecutorScope`: reads of the event's own scope (`history`, `covers`) that are safe from inside the handler on both adapters. On SQLite the handler runs inside the scope's actor, where the host's own reads would wait on themselves.
- A handler may return `refuseDelivery(reason)`: the delivery is journaled terminal with `refused: <reason>`, never retried, and listed by `executorDeadLetters`. It is a return value, so module code cannot produce one.
- `InvokeOptions.onExecutorOutcomes` reports what each executor delivery did in the call's inline post-commit tail (`delivered`, `retrying`, `refused`, `dead-lettered`, `inert`, `routed`), so a request can tell its caller the effect was refused or is pending instead of reporting success.
- `membershipExecutorContractSuite` holds both adapters to it: accept, redelivery, rollback, the refusals, and the inline and retry-backstop paths.
