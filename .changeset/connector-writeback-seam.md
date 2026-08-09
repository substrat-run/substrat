---
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/vertical-host": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/control-plane": patch
---

feat: the connector write-back seam — the platform runs the connector pass for CP-less verticals (#574 phase 1)

A CP-less dispatch vertical cannot run a connector: the connection directory and
its sealed secrets live platform-side, and a pushed script must never hold them.
This lands the approved shape's first phase — the shared control plane runs the
connector pass FOR dispatch verticals, and the vertical opens one narrow
write-back door:

- `vertical-host` mounts three platform-secret-gated verbs:
  `/internal/connector-invoke` (one operation, invoked as the connection),
  `/internal/connector-attachment` (the multipart bytes leg), and
  `/internal/connector-grant` (delivery of the scope-local `connection:<id>`
  grant tuple). Authorization happens in the scope's own DO against that
  delivered tuple — the platform cannot skip the permission check.
- `CloudflareScopeHost` gains the far-end local methods
  (`connectorInvokeLocal` / `connectorAttachmentUploadLocal` /
  `connectorGrantLocal`) and a `connectorDelegation` option for the platform
  end: with it set, `getConnectorScope().invoke`, `getConnectorAttachments()`
  upload, and scope-level `grantToConnection` ride the delegation to the
  deployment actually serving the scope instead of touching the control plane's
  own module-less scope namespace. Directory gates (live connection,
  tenant/vertical match) still run platform-side before every delegated call.
- `VerticalClient` speaks the three verbs (`connectorInvoke`,
  `connectorUploadAttachment`, `connectorGrant`).
- The control plane wires the delegation into its host, seals/opens connection
  credentials with a new `SECRET_BOX_KEY` secret (base64 of 32 bytes, the
  dashboard's exact convention; canonical name `CP_SECRET_BOX_KEY` in
  secrets.mjs), and registers the Scrive sweeper on its scheduled
  `runPlatformSweep` pass — the poll floor now covers hosted verticals'
  connections. `SCRIVE_BASE_URL` selects the provider environment (default:
  testbed).

Phase 2 (webhook ingress terminating on the platform) and phase 3 (outbound
dispatch riding platform-requests) follow.
