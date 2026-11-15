---
'@substrat-run/dashboard': patch
---

The dashboard delivers each app's declared delegations to the team auth-server it signs in with, so another app of the team can act for a person in it. Delivered at install, delete, an Identity change and a version moved in the dashboard, and kept in step from the Apps list.

From this release the dashboard manages `substrat:delegations:<host>` from each app's declared `delegations`, and a grant delivered any other way is replaced on its next pass. Move a hand-delivered grant into the host's manifest (`channels: ['mcp']` for an MCP grant) before you deploy.
