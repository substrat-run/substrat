---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': patch
'@substrat-run/control-plane': patch
---

A module switched off with the schedule kill switch now stays off, without a gap, when its scope's storage is wiped or restored from an older backup. Before, the scope was re-provisioned first and the switch was put back in a second call, and a scheduled run could land in between. Now the reconcile, provision or restore that brings the scope back also switches the recorded modules off, in the same step. This applies only to the scope being provisioned or restored. A vertical gets it once it is redeployed on this release. Until then the platform still switches those modules off after the call, as it did before.
