---
'@substrat-run/engine-absence': patch
'@substrat-run/engine-booking': patch
'@substrat-run/engine-invites': patch
'@substrat-run/engine-invoicing': patch
'@substrat-run/engine-metering': patch
'@substrat-run/engine-protocol': patch
'@substrat-run/engine-workorder': patch
---

Each event's `schemaVersion` now has one home per engine: a `…EventVersions` map that the emit helper stamps and the manifest's `emits` is read from. Emitted versions and manifests are unchanged; an emit site can no longer name a version.
