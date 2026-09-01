---
'@substrat-run/engine-protocol': minor
---

engine-protocol declares its state machine. The four states a protocol instance can hold — `open`, `pending_signature`, `signed`, `voided` — and every verb that moves it between them are now a `defineLifecycles` declaration the compiler checks against the entity's own `status` enum and the engine's declared operations, and the machine is emitted into `model.json` so widening it has to appear in a diff. `protocolLifecycles` and `protocolLifecycle` are exported, so an app can derive "what can I do from here" from the engine instead of re-deriving `status === 'open' && …` in a button.

The seven guards that used to describe the same machine a second time now ask the declaration. Refusals are unchanged: `wrong_status`, `content_frozen` and `already_voided` keep their spellings and their messages, because this engine's three answers say more than one flat "invalid transition".
