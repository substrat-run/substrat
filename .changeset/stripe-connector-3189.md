---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
---

Your app can take payments through your own Stripe account. Connect Stripe from the dashboard with a restricted key; Test connection names the account and says whether it is live or test mode. Your app's worker calls `requestCheckout()` from `@substrat-run/vertical-host` to open a hosted checkout and sends the buyer to Stripe's page. The outcome lands back through the operation your app declares, as a `paymentChange`, a new provider-neutral payment shape in `@substrat-run/contracts`. Stripe's webhook only prompts the platform to read the outcome back from Stripe, and a regular pass catches anything a webhook missed. One reference is never charged twice, and a preview never charges anyone.
