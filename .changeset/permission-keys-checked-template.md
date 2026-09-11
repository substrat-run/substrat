---
'create-substrat': patch
---

The scaffold template's permission keys are now checked against the modules it
registers. `src/operations.ts` already declared `SHOP_PERMISSIONS` as the union a
mistyped `permission:` fails against; `src/provision.ts` now hands the SAME array
to `definePermissions` as `keys`, so the two descriptions cannot part company —
a key the modules declare but the array omits, or the other way round, throws at
module load. The array grew the four engine keys a scaffolded project's modules
declare but no shop operation checks yet (`workorder:assign`, `workorder:report`,
`invoicing:read`, `invoicing:export`), which is what makes the two sets equal.
