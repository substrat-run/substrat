---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/engine-workorder': minor
'@substrat-run/engine-booking': minor
---

A request's invocation line names the lifecycle moves its operation made (`transitions`: entity, from, to). `assertTransition` takes the operation's context as an optional last argument and notes each legal move on it through the new `ctx.noteTransition`. Both scope hosts report the moves after the commit on `onEmitted`, and drop the ones a rolled-back `ctx.atomic` made. The tenant request read projects them. The work order and booking engines pass their context, so their moves are recorded.
