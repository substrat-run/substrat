---
'@substrat-run/cli': minor
---

`substrat dev` runs a vertical's existing dev script and records completed local requests through the already declared trace sink (#2358). A bounded file buffer keeps the newest 256 requests within 8 MiB; each request also prints a compact line with its id, outcome and permission decision. `--no-trace` runs the script unchanged.
