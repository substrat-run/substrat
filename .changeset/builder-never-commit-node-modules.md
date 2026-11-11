---
'@substrat-run/builder': patch
---

Builder: a hosted project gets a `.gitignore` before its first commit and a turn never stages `node_modules`, so the build turn that installs dependencies no longer fails to save with "repository operation failed".
