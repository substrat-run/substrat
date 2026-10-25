---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': patch
---

The fleet walk (RFC wire-signing, follow-on 4) is refused while the control plane's settings are. When `WIRE_KEYS_ROLLOUT` does not parse, or a public key list does not load, every pass of `POST /wire-auth/walk` answers 409 before it walks anything, dry or applied. Its `walkWireAuth` row carries the new `refused` field (the setting and the problem, never a key). Refused settings give every script nothing, and an applied pass would otherwise have written that as a fleet-wide withdrawal. A script never acts on refused settings during a pass either.

A hold keeps the first `WALK_HOLD_BINDINGS_MAX` (64) binding names that differed and counts the rest in the new `walkHold.more`. A hold write that fails is tried once more; when it still fails, the script's failure says the hold could not be written. A pass's cursor now takes any version id after the vertical (the publish route takes any id), so a pass that ends on such a version answers a cursor the next pass accepts. The serving script's position is `<slug>|`.
