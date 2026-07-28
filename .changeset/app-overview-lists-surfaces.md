---
'@substrat-run/dashboard': patch
'@substrat-run/dashboard-web': patch
---

The app Overview now lists every surface's public URL, not just the default one. A
vertical that fronts more than one surface (K-26 — the Egeryds EKA shape) had its second
surface's hostname reachable only from Settings → Domains; the Overview's Production card
and the header's Visit button both hardcoded the app row's single default hostname
(surface `app`), so the second URL was invisible on the page the dashboard links to.

Overview reads the app's full hostname bindings (the same source the Domains tab uses)
and renders one URL row per surface — each surface's canonical active binding, the
default surface first, then the vertical's declared surface order — tagged with the
surface name and label. The OpenAPI / API-docs row stays single: the API is one per app,
surfaces are UI skins of the same vertical. The header's Visit button becomes a dropdown
of surfaces when there is more than one, a plain button otherwise. Single-surface apps
are unchanged, and when the hostnames endpoint isn't backed (embedded/dev) the render
falls back to the single default hostname.
