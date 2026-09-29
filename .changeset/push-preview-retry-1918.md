---
'@substrat-run/cli': patch
---

`substrat preview create` (and `delete` / `ls`) now retries a transient platform fault — a 502, 503 or 504, or a network error (delete and list only) — up to two more times (a create only once the first attempt is known to be over: a 503, or Cloudflare's redacted-fault 502/504 — never a bare gateway timeout, which could still be forking), waiting 1s then 3s, before failing. Each retry prints one line saying what failed — the status and the Cloudflare reference when the response carried them (a 503 may carry no reference, and a network error has neither status nor reference) — so the fault stays visible in a CI log. Any other status, including every 4xx, fails at once as before. The create is safe to repeat: the control plane converges on the tag, rebinding the same preview or re-forking one that died half-built. If all three attempts fail, the error is the same infrastructure-fault message as before.
