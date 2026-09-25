---
"@substrat-run/vertical-auth": patch
---

The places reporter now sends the install's client secret only to the issuer's own origin. The report endpoint an issuer's discovery document names must match the issuer's scheme, host and port exactly, must be `https` (`http` only on a loopback issuer, as the dev issuer is), and must carry no credentials. The report is sent with `redirect: 'manual'`, so a redirect is a failed report and is never followed. A refused endpoint sends nothing, is reported as `failed` like an unreachable issuer, and is logged once with its origin only. The issuer the real auth-server names is its own origin, so nothing deployed changes.
