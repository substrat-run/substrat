---
'@substrat-run/contracts': minor
'@substrat-run/engine-workorder': patch
'@substrat-run/engine-booking': patch
'@substrat-run/engine-protocol': patch
'@substrat-run/engine-invoicing': patch
'@substrat-run/engine-absence': patch
'@substrat-run/engine-invites': patch
'@substrat-run/engine-metering': patch
---

`emitModel` accepts an optional `version`, rendered as the top-level `version` of `model.json` when supplied and omitted otherwise, so a vertical's artifact is unchanged. Each engine passes its `manifest.version`, which gives the field its first reader: the checked-in `model.json`, gated by `lint:model --check`. The field versions the manifest shape, not the package, and is bumped only when that shape changes.
