---
'@substrat-run/dashboard': patch
---

Apps that sign in with a team auth server are now registered there as places, so the auth server's **Your account** page can list them for the people who use them.

The Apps list does this after it has loaded: once per team, again when a new install appears, and every few minutes otherwise, which is how an Identity change catches up. Each auth server is told the team's whole set of apps that sign in with it. An app you delete, or move to another issuer, drops out of the next delivery and out of everyone's list. An auth server that is down does not hold up the others, and what it missed is retried on the next load. An app with no hostname yet, or whose identity could not be read, is never dropped by mistake: a pass that cannot read an app's identity delivers nothing and tries again. An auth server takes at most 500 of a team's apps; past that, the newest are left out and the dashboard logs which.
