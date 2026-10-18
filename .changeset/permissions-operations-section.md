---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/cli": minor
"@substrat-run/model-view": minor
---

`PERMISSIONS.md` names the key each operation checks. A new Operations section lists every registered operation with the key it declares, and what that check narrows to: the scope, one record (id from an input field, or resolved in the handler), a whole ref, or a walk over rows. An operation whose handler checks a key with nothing declared is listed as "checked in code, not declared", never given a guessed key. To make this readable, the bound operations a module registers now carry the check each operation declares (`operationChecksOf` in `@substrat-run/contracts`, read the same way as the concurrency map), and the host itself ignores it. `substrat changeset` and `lint:changeset-bump` read the section: an operation moved to another key, narrowed differently, added or removed is a permission change, at least minor and listed for review. `substrat plan` shows each lifecycle transition with the key its operation checks and the roles and per-record grant shapes holding it. `@substrat-run/model-view`'s `parsePermissions` returns the section as `operations`.
