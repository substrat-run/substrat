---
'@substrat-run/engine-workorder': patch
---

`workorder/start` declares `workorder:report` — the key its handler has always checked — instead of `workorder:assign` (#960). The declaration is what the conformance receipt, `lint:permissions` and a vertical's `defineEngineRoutes` binding read, so a role widened to `workorder:assign` on its strength could not start work. No permission key or handler changed; `test/permissions.test.ts` now holds every declared permission to the one its handler checks.
