---
'@substrat-run/dashboard': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

The install is now a durable, inspectable operation (#424, the remaining half). The
dashboard records each stage of an install — directory → provision → activate →
hostname → identity — as a per-step row in the platform-request shape
(status/attempts/last_error), written live as the install runs. The Apps view renders
the step list on a provisioning card (polling while it runs) and, on a failed one, shows
the step that died with the downstream error VERBATIM; Resume re-enters the same rows,
bumping attempts, so a healed install reads `provision ✓ (2 attempts) → activate ✓`. A
`provisioning` row whose directory scope is already `active` is reconciled on read
(case 4's eternal spinner heals on the next page load). CLI parity: `substrat installs
<slug>` lists a workspace's installs with directory status + served hostname, and
`substrat scope status <scopeId>` prints one scope's directory truth (status, bound
version, serving script, role health) — backed by tenant-narrowed builder access to the
directory read routes (`GET /scopes` forces the caller's tenant; per-scope reads hide a
foreign tenant as 404).
