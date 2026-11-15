---
'@substrat-run/cli': patch
---

`packedFilesOf` and `packStoreDriverDir` take an optional `limits` (files, code modules, bytes), defaulting to `STORE_RELEASE_LIMITS`, the control plane's own limits. `substrat store-driver upload` behaves as before.
