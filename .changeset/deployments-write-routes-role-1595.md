---
'@substrat-run/dashboard': patch
---

A team member with the `viewer` role can no longer promote, roll back, delete or preview a vertical.

The dashboard's deployment routes checked that you were signed in and that the vertical was your team's, and stopped there, so a `viewer` — a role meant to look but not touch — could promote a version to `prod` (including a rollback), remove a vertical from the registry, create or reap a preview, and bind a custom domain to one. Those five now ask the same question the app-install actions already ask, and answer `403` to a `viewer`. `owner`, `admin` and `member` are unchanged. Reading a vertical's deployments, versions, previews and history is unchanged too.

No role or permission changed: this is the existing `dashboard:provision-app` check, applied where it was missing.
