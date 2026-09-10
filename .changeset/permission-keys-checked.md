---
'@substrat-run/contracts': minor
---

`definePermissions` keeps its input's literal types, and checks the key list it
is given (#1208).

`defineOperations(entities, KEYS)` turns a mistyped `permission:` into a compile
error naming the real keys, and that is worth having — but `KEYS` could not be
derived from anything a vertical already wrote. The declared surface carries
every key inside `modules`, except that a manifest is `moduleManifest.parse(…)`
output: by the time `definePermissions` sees a key it is the branded
`PermissionKey`, and the literal is gone one step earlier than it looks.

So the array stays, and the guarantee moves into the platform. `PermissionsInput`
gains an optional `keys`, `definePermissions` is now
`<const T extends PermissionsInput>(input: T): T` so the literals survive the
call, and `PermissionKeysOf<typeof permissions>` reads the union back off the
result. When `keys` is given, `definePermissions` throws at module load if it and
the modules disagree in either direction, naming the extra and missing keys — a
vertical that carried its own "the keys still match the modules" test can delete
it. Omitting `keys` yields `never` rather than `string`, so a surface that never
declared them cannot quietly widen `defineOperations` into accepting anything.

Additive: the runtime value is what it always was, and every existing call site
compiles unchanged. `demos/todo` adopts it as the reference.
