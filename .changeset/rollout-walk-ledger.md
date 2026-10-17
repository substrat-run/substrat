---
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/contract-tests': patch
---

A store driver rollout or rollback now pages across any number of verticals (#2312). Each request walks at most 300 verticals and uploads at most 100 scripts, then pauses. Posting it again continues from a walk ledger the directory keeps per declaration, so a vertical declared between posts is still walked and none is walked twice. The fleet-size refusal (409) is gone. `ROLLOUT_FLEET_MAX` is renamed `ROLLOUT_WALKS_PER_REQUEST`, and a rollout answer carries `remaining`. A failure part way returns every vertical the attempt reached, earlier requests included; past 300 it ends `diverged`, and the rollback, which pages the same way, converges the fleet.
