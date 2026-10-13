---
'@substrat-run/dashboard': patch
---

The app page's "What this app calls" panel no longer reports "grants this app nothing" for an app pushed under its tenant (`<tenantSlug>/<slug>`). The target stores its grants under the bare name the manifest declares, and the panel compared them with the registered name, so a grant that was there read as missing.
