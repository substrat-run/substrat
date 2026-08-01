---
'@substrat-run/dashboard': patch
'@substrat-run/demo-manyfold': patch
---

Domains tab: the surface field is always a picker, and Manyfold declares its surface

Binding a hostname needs a surface, but the picker only rendered as a dropdown when the
vertical DECLARED its surfaces (package.json `substrat.surfaces` → the registry). A vertical
that declared none — Manyfold among them — fell back to a bare free-text box with no hint of
what to type.

Two changes, one per layer:

- **Manyfold declares its surface** (`substrat.surfaces: [{ name: 'app', label: 'App' }]`) —
  the canonical source of truth. Manyfold serves one routed surface, `app`; the delivery view
  is a preview inside it, not a separately-routed surface. Reaches the dashboard picker on the
  next push to the tenant.
- **The dashboard picker is always a dropdown.** Options are the declared surfaces when the
  vertical names them, else the surfaces already bound ∪ the conventional `app`, so an
  undeclared vertical still gets a usable menu instead of a blank box. An "Other…" option
  reveals the free-text field, keeping an undeclared surface valid — declaration is UX, not
  contract (routing.ts).
