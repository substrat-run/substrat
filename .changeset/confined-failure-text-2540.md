---
'@substrat-run/control-plane-api': patch
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

A confined caller (a tenant credential or a builder) no longer reads what an upstream, a store or a deployment answered when a failure reached installs that may not be its own (#2540). It sees only its own scopes and no upstream text; staff keep the text.

- **The answers.** These say that the step failed and carry a `reference`:
  - a prod promote's failed in-place serve (`502`, whose `detail` is now the fixed sentence), its store backfill (`storeBackfill.error`) and an export-break listing that could not be read (`exportBreaksUnavailable`);
  - a refusal to judge whom a promote or bind breaks (`503`), on every route that reaches it, the promote and `GET …/promote-impact` among them. The kernel's sentence names the app it could not read and that read's error, so the API answers it itself (`isExportBreakUnjudged`, new in the kernel);
  - on `POST /tenants/:tenantId/scopes/:scopeId/provision`, which a builder may call on any install of its own vertical, both `storeError` and a failed reconcile's answer.

  Staff are answered the text, with the reference beside it.
- **Where the text goes.** To the `control-plane.unhandled` log line, with the request's method, path, vertical, version, tenant and scope, and to an ops-failure row with no tenant on it, so it never appears in a tenant's `GET /ops-failures`. Both carry the reference. When the text carries an upstream trace handle (`reference = <id>`), that id is the reference, so the #559 lookup still finds it.
- **Rows a tenant reads back.** An ops-failure row attributed to a tenant says what the request was answered, whoever made it, staff included. That is only as clean as the answer, which is why the answers above changed. When the failure's own text differs, the API writes one failure with a `detail` (`OpsFailureInput.detail`, new in the kernel). Both adapters write it as the tenant's row plus a row with no tenant carrying the text, under one reference, and count it once: the issue's sample is the text. This covers the 5xx backstop's row and the rows of every answer above. The staff failure digest lists such a pair once, as its text, under its tenant. The console's failure view links a tenant's row to every row with its reference.
