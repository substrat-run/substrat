---
'@substrat-run/kernel': minor
'@substrat-run/control-plane-api': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

Three writers below the API now file a tenant's ops-failure row the way the API does (#2554, after #2540): the tenant's row says what happened, with the platform's own reference, and the failure's text goes to a row with no tenant under the same reference, which only staff read.

- **A lifecycle delivery that did not land** (`scope.lifecycle`, `deliver`). The tenant's row says that the lifecycle did not reach the deployment serving the scope and that the heal sweep will deliver it again. The deployment's or runtime's error text is on staff's row only. The `foreign-epoch` row is unchanged: its text is the platform's own and names only epochs.
- **An intent the platform drain gave up on, or settled `failed`** (`intent.<kind>`, `attempt-ceiling` and `terminal`). The tenant's row reads `platform intent <id> failed (reference …)` or `… gave up after <n> drain attempts (reference …)`, and the handler's error is on staff's row.
- **A copy-ledger backfill row whose store read threw** (`scope.copy-backfill`, `unresolved`). The tenant's row gives the reason without the throw. Staff's backfill page is unchanged.

`withheldOpsFailure`, new in the kernel, builds that input for every writer, the API's routes included. Subject erasure follows the drain's pair: a failure about an intent the erasure tombstoned is redacted on the tenant's row, on staff's row of the same scope, and on the issue sample it became, even when staff's text begins with an upstream reference marker.
