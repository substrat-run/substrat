---
'@substrat-run/dashboard': patch
'@substrat-run/dashboard-web': patch
---

The app Deployments tab no longer dead-ends a builder on their own vertical. The
per-app deployments read now says whether the app's vertical is one the tenant
pushed (`owned`, with the real `listed` flag alongside), and the tab words itself
accordingly: for an owned private vertical the banner says promotion is self-serve
and links to the Verticals page instead of claiming prod is a staff action (true
only for listed/foreign verticals). When the newest admitted version isn't what
prod points at — the exact state where no "Update to latest" can be offered — the
Running card now explains why and links to the promote button (or names the staff
handoff, for the non-owned case) rather than showing nothing.
