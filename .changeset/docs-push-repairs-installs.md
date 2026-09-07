---
---

docs: guide/deploying.md and concepts/deploying.md say that a promoted version repairs its own installs (the `provisionedVersionId` receipt and the sweep's reconcile phase, which runs once a scope is bound to the new version), and that `onProvision` must therefore be idempotent (#1249).
