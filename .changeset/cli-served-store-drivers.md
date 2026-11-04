---
'@substrat-run/cli': patch
---

`substrat push` reads the control plane's store-driver registry dropping keys it does not know, so a newer plane does not fail the push; a `--store-drivers` file stays strict.
