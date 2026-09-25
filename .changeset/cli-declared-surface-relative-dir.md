---
'@substrat-run/cli': patch
---

`substrat push` reads the declared surface again when the vertical is named by a relative directory (`substrat push demos/ticket0`). 0.35.0 wrote that path into an import specifier, where a relative path is a bare package name, so every such push failed with "Cannot find package".
