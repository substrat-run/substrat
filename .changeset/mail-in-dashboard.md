---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
---

An app's mail-in address in the dashboard: Settings → Integrations shows it with its counts, and a team owner or admin can get, replace or turn it off and set who may send. The control-plane API gains `GET`/`POST /tenants/:t/scopes/:s/mail-in` over a host-injected `mailIn` door, and contracts gain `mailInAddressAct` and `mailInStanding`.
