---
"@substrat-run/control-plane-client": patch
"@substrat-run/cli": patch
---

`npx @substrat-run/cli` installs again. `@substrat-run/control-plane-client@0.1.0` was published with a `workspace:` dependency that npm cannot resolve, so installing the CLI failed with `EUNSUPPORTEDPROTOCOL`. This release republishes the client with a resolvable manifest, and the CLI now requires that version.
