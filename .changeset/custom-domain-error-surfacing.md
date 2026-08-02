---
'@substrat-run/control-plane-api': patch
---

Custom-hostname failures now say what actually broke, and heal themselves. A 401/403
from Cloudflare's custom-hostname API is a platform misconfiguration (the API token
missing 'Custom Hostnames: Edit' on the SaaS zone — its own permission group, not
covered by 'SSL and Certificates: Edit'), not the tenant's DNS — the
provisioner's error now names the token so the note stored on the binding sends the
operator to the right place instead of the tenant to their DNS provider. The reconcile
sweep additionally retries `failed` rows that have no Cloudflare hostname id — a create
that never landed (bad credential, transient error) now self-heals on the next pass
once the cause is fixed, while `failed` rows *with* an id (a real validation verdict)
stay terminal for the sweep. Dashboard side (unpublished): the per-app Domains tab now
renders the failure note, the DNS records to publish, and a per-row "Check again",
and the add flows surface an immediately-failed issuance instead of a bare pill.
