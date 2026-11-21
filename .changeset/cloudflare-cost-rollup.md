---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

The platform keeps what Cloudflare bills it for, per tenant, vertical and scope: a daily cost rollup reads each closed day of Workers CPU, Durable Object requests, rows read and written, storage write units and duration from Cloudflare's analytics, with the 95% confidence interval where a dataset is sampled, and attributes each row through the directory (a Durable Object to the scope whose object id the directory recorded, a script to its vertical, version and owner on that day). Quantities only, no price. Each scope's object id is learned from the script that holds its data (`/internal/scope-object-id`), and staff read the rollup at `GET /meters/cloudflare-costs` and load an older snapshot day at `POST /meters/cloudflare-costs/days`.
