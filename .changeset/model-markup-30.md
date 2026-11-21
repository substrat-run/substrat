---
'@substrat-run/builder': patch
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
'@substrat-run/docs': patch
---

Model tokens are marked up 30% over the provider's list price, up from 20%, everywhere the platform prices them: the default margin on platform-provided model calls a vertical makes (`DEFAULT_MODEL_MARGIN_PERCENT`, still overridable with `MODEL_MARGIN_PERCENT`), the hosted code-review spend limit that counts at that rate, and the builder studio's Usage pane. The builder now computes its factor with the ledger's `marginFactor` instead of a second copy.
