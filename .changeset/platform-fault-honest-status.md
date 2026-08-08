---
"@substrat-run/vertical-host": patch
"@substrat-run/control-plane": patch
---

fix(vertical-host,control-plane): a platform fault answers 502, and the control plane keeps its own logs (#559)

The `/internal/*` error envelope defaulted every unrecognized throw to 400 — so a
Cloudflare DO SQLite storage fault (`internal error; reference = <id>`) crossed the
control plane's verbatim passthrough and reached CI dressed as "you sent a bad
request", unresolvable by anyone but Cloudflare support and invisible to every
retry convention that (correctly) refuses to retry a 4xx. The envelope now
recognizes infrastructure-fault shapes — workerd's `retryable`/`overloaded` flags,
the redacted DO SQLite message, DO resets — answers 502 with the message intact,
and logs `vertical-host.platform-fault` structured so the vertical's observability
keeps stage + reference queryable. App errors that merely mention "internal error"
mid-sentence stay 400; explicit HTTPException statuses stay authoritative.

The control-plane worker also gains `observability: enabled` (prod and env.test):
its own `deploy.upload.failed` / `control-plane.unhandled` diagnostics previously
existed only in a live `wrangler tail`.
