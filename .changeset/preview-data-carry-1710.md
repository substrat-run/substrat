---
'@substrat-run/control-plane-api': patch
---

A push to an existing preview now brings the preview's data with it. Each pushed version of a hosted vertical is its own deployment with its own storage, and re-pointing a preview at the new version used to leave its data behind. From the second push on, the preview served the new code against an empty store. The control plane now copies the preview's data into the new version's deployment first, and re-points the preview only once the copy has landed. If the copy fails, the preview stays on the previous version with its data, and re-running the push tries again. `scope bind` does the same for a scope that runs on its bound version's own deployment, such as a long-lived test environment forked from prod. A write made to the preview while the push runs may be lost, and `preview create` says so in a `Data:` line when it moved data (#1710).
