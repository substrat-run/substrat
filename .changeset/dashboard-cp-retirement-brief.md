---
'@substrat-run/dashboard': patch
---

Documentation only: an inventory and migration plan for retiring the dashboard's own control-plane directory, plus a correction to the architecture note describing it.

The note said that directory holds identity links, mirrored into the shared one. It holds considerably more — the dashboard runs as a vertical with a scope per team, so it is that host's whole directory: tenants, scopes, roles, grants, entitlements, its catalogue and its audit log. Only the tenant row and the identity links are mirrored anywhere; the scope, roles, grants and entitlements exist in one place and nowhere else, and the catalogue is half local and half the shared plane's, merged when read.

That difference changes what the move is. The plan now lists what is held and who writes it, the three questions that can only be answered by reading production, the part that cannot be moved at all without someone deciding to lose it, and a sequence where everything before the cutover is reversible by putting one binding back.

Nothing has been run. This is the data move written down for review, which is what the migration checkpoint asks for.
