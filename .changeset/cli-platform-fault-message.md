---
"@substrat-run/cli": patch
---

fix(cli): a redacted Cloudflare fault is named for what it is (#559)

A 5xx whose body carries `internal error; reference = <id>` now prints an
explanation with the error: it is a Cloudflare-side infrastructure fault inside
the platform — not a problem with the push or the code — and the reference is a
Cloudflare support handle, recorded in the console's Operations → Failures
view. The old framing ("a control-plane trace only its operator can resolve")
pointed at the wrong operator. Honest refusals (4xx) and ordinary 5xx keep
their messages untouched.
