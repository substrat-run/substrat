---
"@substrat-run/control-plane-api": patch
---

`POST /verticals/:slug/versions` now parses `manifestJson` before storing it, and answers 400 naming the problem when it is not JSON or not a deploy manifest. Before, a string nothing could read was stored, and every later read of that version (registry, schedules, flow, model, assets, and the manifest rebuild promote and backout run) failed with a 500.
