---
---

The dispatch egress worker no longer refuses a vertical's call to the platform's own relay: the control plane's origin (`CONTROL_PLANE_URL`) sits on a different zone from the tenant apps, so a version that declared any outbound surface — including the empty one the CLI pushes by default — was 403'd on `/internal/email/send`. Private packages only (`apps/vertical-egress`, `docs/`).
