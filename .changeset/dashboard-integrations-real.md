---
"@substrat-run/control-plane-api": minor
"@substrat-run/dashboard": minor
"@substrat-run/demo-meridian": patch
---

feat: the dashboard Integrations page becomes real — tenant-scoped connection routes on the control plane, a Scrive connect flow in the app's Settings, and manifest `requires:` driving the "enabled but missing its settings" state

The control plane grows a tenant-scoped connection surface (`GET/POST /tenants/:t/connections`,
`DELETE /tenants/:t/connections/:id`) — the POST reuses the §3.5.2 relay's upsert semantics
(create, or rotate the one live row in place so its grant tuples survive), behind platform-actor
auth. This is the door the dashboard needed: its own directory holds its GitHub connections, but
a provider credential a platform-run connector consumes (Scrive) must land in the shared plane's
store — the one `connector:<provider>` dispatch actually opens.

The dashboard's Settings → Integrations tab and the account-level Integrations page drop their
demo fixtures: a vertical declares a provider in its manifest `requires:` (Meridian now declares
`scrive`), the tab renders it connect-or-"required, not connected", and the connect dialog
collects the provider's server-declared credential fields (Scrive's OAuth1 four-part), write-only.
Authorization is the in-scope `dashboard/begin-connection` act (`dashboard:manage-integrations`);
the credential rides one call to the store that seals it. A declared-but-unconnected provider
never gates the app — a dispatch with no live connection settles pending and delivers once
connected. Scrive connections are granted `protocol:record-signature` + `protocol:attach`, so
both the signature write-back and the sealed-PDF landing work.
