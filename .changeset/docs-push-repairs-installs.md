---
---

docs: guide/deploying.md and concepts/deploying.md say that a push repairs its own installs (the `provisionedVersionId` receipt and the sweep's reconcile phase), and that `onProvision` must therefore be idempotent (#1249).
