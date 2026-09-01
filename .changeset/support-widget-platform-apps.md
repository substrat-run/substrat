---
'@substrat-run/oidc-rp': minor
---

`signVisitorIdentity` — vouch for the session this package established to a widget
embedded from another origin. HMAC-SHA-256 over the subject, hex, keyed by a secret that
widget's backend also holds: the construction Intercom calls `user_hash` and Help Scout
calls a Beacon signature. It lives here beside the thing it vouches for because the
console and the dashboard both embed Substrat's own support desk, and the alternative is
the same security-critical MAC written twice, in two workers, with two chances to
disagree about an encoding — a disagreement that surfaces as "signature does not verify"
for every visitor, indistinguishable from a mistyped secret.
