---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
---

Ops-failure rows carry the error's SHAPE (#1233, first step of the Issues
view). `opsFailureEntry` gains `origin` (who refused: `platform` / `provider` /
`unknown`, the #841 attribution) and `code` (the taxonomy code when the refusal
was one of ours) — both nullable, and a null is a fact: the writer predates the
columns or could not classify, never a guess. The intent drain already computed
exactly this attribution for the journal's `last_failure` and dropped it when
writing the fleet row; now it rides along on both the attempt-ceiling and
terminal paths. Every other control-plane recorder hands its caught throw to
`recordFailure`, which attributes in one place — the same posture as the
`reference = <id>` extraction. `GET /ops-failures` narrows by `code`, so a
failure class is a column filter, never a message regex — which is what a
fingerprint-grouped issues view needs to exist at all.
