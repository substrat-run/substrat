---
"@substrat-run/control-plane-api": patch
"@substrat-run/control-plane": patch
---

The Pipelines lake sink now sends each event's `delegation` (the app that acted for the person, or null). The live stream must be recreated from the current stream schema before this is deployed.
