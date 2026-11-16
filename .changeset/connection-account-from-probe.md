---
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
---

A Stripe key for another account no longer has to be refused. The platform now tells Stripe connections apart by the account and mode Stripe names for the key, so a key for the same account replaces the old one, and a key for another account (or a live key beside a test one) becomes a second connection, listed on its own in the dashboard. A connection made before this holds no account and keeps the old rule until it is disconnected. In `@substrat-run/control-plane-api`, a connection inspector can declare `accountFromProbe`, and the connection upsert then takes the account from the provider's connect-time probe: the probe runs before the store, and a probe that cannot name the account stores nothing.
