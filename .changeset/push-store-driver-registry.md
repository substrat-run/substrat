---
'@substrat-run/cli': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane-client': minor
---

A push judges its scope stores by the driver registry of the control plane it talks to (#2813): `GET /store-drivers?vertical=` returns the registry as that vertical is judged by it, and `substrat push --store-drivers <file.json>` (also on `--check`) judges by a registry of your own.
