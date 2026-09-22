---
'@substrat-run/demo-ticket0': patch
---

The desk keeps its team auth server's "Your places" list in step with who is on the desk.

After `/api/me` resolves a signed-in person, the desk tells its auth server whether they are bound to it. This covers the owner's first sign-in, a claim link and an accepted invite, at that person's next request. A platform reconcile also sends the desk's whole membership, so a report that went missing is repaired. Nothing is sent for a desk on an external issuer.
