---
'@substrat-run/connector-bolagsverket': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
---

A vertical can look an organisation number up in Bolagsverket's register: it emits `bolagsverket.organisation-lookup-requested`, declares a `connections` landing for `bolagsverket`, and the platform looks the number up with the tenant's connection and lands the answer through that operation within seconds.
