---
"@substrat-run/contracts": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/vertical-host": minor
"@substrat-run/control-plane": patch
---

contracts: the wire envelope's version 2 (`substrat-wire/2`, K-66) adds the caller app, caller scope and actor lines. `verifyWireEnvelope` accepts both versions and refuses a version 2 caller row that does not fit its target (`caller`); signers still send version 1 unless told otherwise. `wireVerifiedCallerOf` reads what a verified version 2 call signed, and `wirePersonActor` binds an `onBehalf` token. The capability record's `envelope` may now be `2`.
control-plane-api: the platform entry verifies both versions, hands a verified version 2 call's caller and actor to the vertical in the isolate (never a header), and writes the envelope version on its wire line. An upload records `envelope: 2`; the fleet walk reads an unrecorded script's version from its own entry.
vertical-host: `/internal/vertical-invoke` refuses a call whose body disagrees with the caller and actor its verified version 2 envelope signs, a different `onBehalf` token included.
control-plane: ships the uploader that gives every pushed version the entry that verifies both envelope versions.
