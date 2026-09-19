---
'@substrat-run/control-plane-api': patch
---

`ControlPlaneError` takes an optional third constructor argument, `probe` — the provider's own answer when the plane refused a connect because the credential was rejected upstream (#605, 422). Additive: every existing `new ControlPlaneError(status, message)` is unchanged, and `probe` is `undefined` unless a caller passes one. The dashboard declared its own class of the same name to carry exactly this field; it now imports this one instead of keeping a second copy.
