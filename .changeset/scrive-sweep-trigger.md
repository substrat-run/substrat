---
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/connector-scrive': patch
---

feat: `definePlatformSweeperDO` — the Cloudflare trigger for `runPlatformSweep` (scheduler.md §3.0, the last blocker on the Scrive poll path, #96)

A singleton Durable Object whose `alarm()` runs one platform-sweep pass and re-arms itself only
after the pass settles — the workerd analogue of the kernel's `startPlatformSweeper`, with the
same non-overlap guarantee (a concurrent kick joins the in-flight pass; the next alarm is a gap
after settle, never a fixed rate; a pass that sinks whole is reported and the loop re-arms). An
alarm rather than a cron because a hosted vertical is pushed into a Workers-for-Platforms
dispatch namespace, where `triggers.crons` is not honoured — the alarm self-arms from code
(`ensureArmed()`, idempotent) and needs no wrangler config; where a cron IS available, point
`scheduled()` at `ensureArmed()` as the safety net. Exercised end to end in workerd: a real
alarm drives the real `runPlatformSweep` against live SCOPE/CONTROL_PLANE Durable Objects.

The Scrive connector's README now points its "schedule the poll" caveat at both shipped
triggers (node interval / workerd alarm) and names the one remaining deployment gap: a
control-plane-less vertical has no connection directory to enumerate, so its sweep waits on
connections becoming reachable from the vertical's runtime.
