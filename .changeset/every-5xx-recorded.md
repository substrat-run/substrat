---
'@substrat-run/control-plane-api': patch
---

Every 5xx the control-plane API answers now lands an ops-failure row, including the ones a route answers itself instead of throwing. A failed preview re-push used to answer 502 with a Cloudflare `reference = <id>` and leave no record, so the reference the CLI printed found nothing in the console. The row names the vertical by its full slug and the tenant that owns it, so it also shows in that tenant's dashboard, and its write is handed to `waitUntil` so it is not cut off once the response is sent.
