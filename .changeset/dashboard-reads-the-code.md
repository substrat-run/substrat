---
'@substrat-run/control-plane-client': patch
'@substrat-run/vertical-host': patch
---

**`ControlPlaneError#problemCode`** reads the taxonomy code the plane's problem document declared (#113), so a caller can branch on what a refusal is instead of on its sentence. It is `undefined` for a body that named no code: an `about:blank` relay, a route the plane does not have, a transport error, or an error raised on the caller's side.

**`vertical-host`'s `/internal/query`** recognises the read-only console's refusal by its `validation_failed` code instead of the words `read-only console`. The status (400) and the sentence are unchanged.
