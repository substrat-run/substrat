---
'@substrat-run/contracts': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/demo-auth-server': patch
---

Platform sign-in can no longer leave an Auth Server holding a relay secret the relay has rotated away: overlapping reconciles take turns to hand out a secret, each secret carries a generation the install checks, and an install holding a dead one gets a fresh one on its next reconcile.
