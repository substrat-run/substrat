---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/router': minor
---

The field-coverage walk is now switched on by the router, per request, instead of by a setting on each vertical (#1923).

- The router gains an optional `FIELD_COVERAGE_SAMPLE_RATE`, a decimal in `(0, 1]` (`0.01` is one request in a hundred). It is off when absent or set to anything else, including a value above one. On a request inside the sample, the router sends `x-substrat-field-coverage: on` beside its signed assertion. Changing the rate, or turning it off, never needs a vertical to be pushed again.
- The stamp honours that header only when the request's router assertion verifies. A request that did not come through the router, or whose signature is wrong, is never walked. `fieldCoverageArmed(request)` answers whether a request is armed, and the operation routes and the MCP door both read it.
- `FIELD_COVERAGE_BINDING` is removed from `@substrat-run/contracts`. Nothing set it. `FIELD_COVERAGE_HEADER`, `fieldCoverageSampleRate` and `fieldCoverageSampled` replace it.
- `tallyFieldCoverage` in `@substrat-run/control-plane-api` is the one way to read the reports. It counts per operation and field for one tenant, and only from that app's own scripts. It refuses malformed or oversized reports and keeps nothing per request.

A vertical's operations are walked only after it upgrades and pushes again, since the walk runs in its bundled `vertical-host`. The platform's entry carries the new stamp on the next platform deploy.
