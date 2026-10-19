---
"@substrat-run/cli": patch
---

`substrat plan` reads whether each permission key is reserved to a system principal (the registry column `lint:permissions` writes once a manifest declares `holder: 'system'`). A key that stops being reserved is a flagged widening at minor and one that becomes reserved is a flagged narrowing, as a role gaining or losing a key is. A `PERMISSIONS.md` without the column reads as nothing reserved. Its permission table shows a key whose reservation changed, marked on the side where it is reserved, and gives no rows for a registry it cannot read.
