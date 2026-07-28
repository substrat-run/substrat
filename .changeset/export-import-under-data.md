---
'@substrat-run/dashboard': patch
'@substrat-run/dashboard-web': patch
---

Export & import moved from the Previews tab to the Data tab. It operates on the app's
data wholesale, so Data is where a user looks for it; its only tie to Previews — the
safety preview an import forks first — is now named in the success message ("… in the
Previews tab") instead of relying on the list being on the same screen. The Previews
tab refetches on open, so the explicit refresh callback is gone.
