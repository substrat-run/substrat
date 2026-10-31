---
'@substrat-run/cli': minor
'@substrat-run/control-plane-client': minor
---

`substrat entitlements list|grant|revoke` manages a workspace's entitlement keys (grant takes `--plan`, `--expires`, `--quota`); the client gains `revokeEntitlement` and path-encodes a key containing a slash.
