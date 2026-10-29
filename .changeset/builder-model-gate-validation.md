---
"@substrat-run/builder-workspace": patch
---

Fix model validation before scaffolding by resolving contracts from the builder toolchain and running the model typecheck directly, even before a project has a package manifest. Include model artifact validation in shared gate checks so a model that cannot load never reports green. Preserve failed turns and the last good artifact, and validate direct rechecks without rewriting the artifact.
