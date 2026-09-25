---
"@substrat-run/control-plane-api": patch
---

`POST /verticals/:slug/versions` now parses `manifestJson` before storing it, and answers 400 naming the problem when it is not JSON or not a deploy manifest. Before, a string nothing could read was stored, and every later read of that version (registry, outbound, assets, promote) failed with a 500.
