---
"@substrat-run/control-plane-api": patch
---

fix(control-plane-api): the platform's own export→restore calls ride out a transient blip (#559)

When the control plane talks to a vertical deployment on the caller's behalf —
the preview fork's restore, the snapshot copy, a backup restore, adopt/rebind
onto the serving script — a one-shot downstream 5xx (a DO storage blip) now
heals on the same bounded backoff the install path already uses, instead of
failing the request. Cheap at exactly these call sites: the dump is already in
memory and the far end is drop-then-replay idempotent — unlike CI's blind
retry, which burns a freshly pushed version per attempt. Honest refusals (4xx,
and 501 = not implemented) still surface immediately, and a persistent fault
still exhausts, answers honestly, and lands its ops-failure row.
