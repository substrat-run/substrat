---
'@substrat-run/cli': minor
---

`substrat changeset` writes a changeset whose bump is computed from what changed in the vertical's `model.json`, `openapi.json` and `PERMISSIONS.md`: removed or narrowed → major, added → minor, docs only → patch, and any permission change at least minor and listed for review. `substrat changeset --check` refuses a changeset that declares less than that, and `--json` prints the classification.
