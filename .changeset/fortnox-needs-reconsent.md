---
'@substrat-run/contracts': minor
'@substrat-run/connector-fortnox': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
---

A connection probe and a connection's activity can now say what its consent covers (`consent: { granted, missing, checkedAt }`). A non-empty `missing` means the connection needs a new consent round, not new keys.

Fortnox reads the scopes each token mint names. A consent missing a scope the platform asks for shows as "needs re-consent", never as a refused credential. The probe reports it without refusing, and the sweep fails only the bindings that need the missing scopes, with a readable reason and no 403. `completeFortnoxConsent` returns `grantedScopes`, and its `financialYears` is `null` when the consent has no `bookkeeping` scope.

The dashboard's connection view shows **Needs re-consent** with the missing scopes and a **Re-consent** button that starts the usual consent round. The consent callback names a shortfall, and passes it back to a vertical as `missing`.
