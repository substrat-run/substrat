---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
'@substrat-run/console': patch
---

Model usage is reconciled against what Cloudflare saw (#1054). Each closed UTC day of the model usage ledger is compared, per tenant, scope and model, with AI Gateway's analytics (the five attribution keys ride as gateway metadata) and Workers AI's. Each row is matched, a discrepancy (fewer successful gateway requests than ledger lines, or a cost difference beyond $0.01 and 10%), ledger-only, or gateway-only. A gateway-only row is a call no ledger line accounts for: the model host never raised a `model-usage` intent. Gateway calls with no attribution, calls for a tenant this directory does not hold (another environment in the same account), and Workers AI calls that went through no gateway (estimated at $0.011 per 1,000 neurons) are totalled beside the rows. The ledger is never corrected from either source.

- contracts: `modelReconciliationDay`, `modelReconciliationRow`, `modelReconciliationStatus` and `modelReconciliation`, and the `model-reconcile` sweep-run kind.
- control-plane-api: `reconcileModelDay` (the fold), `createCfModelCostReader` (one GraphQL read per day; it refuses an answer at the 10,000-group ceiling rather than reconcile part of a day), `reconcileModelDays`, `runModelReconciliationPass`, and the staff-only `GET /model-usage/reconciliation?since=&until=` (closed UTC days, at most 14, computed on request; 501 without a cost reader).
- control-plane: the scheduled pass reconciles each closed day once, two days a pass and seven days back. It files each gateway-only row, each discrepancy, and the day's no-gateway Workers AI total as staff ops-failure rows with no tenant (`sweep.model-reconcile`), and writes a `model-reconcile` sweep-run row per day. Production only, through the checked-in `MODEL_RECONCILIATION` var.
- console: Sweep runs can filter to "Model reconciliation".
