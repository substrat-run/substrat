---
'@substrat-run/contracts': minor
'@substrat-run/control-plane': patch
---

Code reviews have a per-workspace daily spend limit. A review is refused before its model call once the workspace's reviews would cost more today than the limit, and an upload is answered `429` with `reason: review_spend_limit_reached`. Staff set the limit per workspace as the `review` entitlement's quota, in cents. The `rate_limited` problem document may now carry a `reason`.
