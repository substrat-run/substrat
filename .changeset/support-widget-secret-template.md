---
---

Repo-only: both platform secret templates name `SUPPORT_WIDGET_SECRET`. The key was added
to the `scripts/secrets.mjs` map when the console and dashboard started embedding the
support desk, but neither `secrets/platform.*.env.example` grew a line for it — so the map
named a key the template did not, and the obvious place to paste the desk's verification
secret was the committed template rather than the gitignored file beside it. No published
package changes.
