---
'@substrat-run/dashboard': patch
---

Apps that sign in with a team Auth Server now have their MCP endpoint registered there, so a client like Claude Desktop can connect without anyone configuring the issuer.

The dashboard registers one resource per hostname the app answers on (`https://<hostname>/api/mcp`): at install, and on an Identity change, where it is also cleared at the issuer the app left. Deleting the app un-registers it. Apps installed before this are registered the next time anyone on the team opens the Apps list. None of this can fail an install, a save, or a delete. A vertical that mounts its MCP endpoint somewhere other than `/api/mcp`, or pins a different resource identifier, is not covered.
