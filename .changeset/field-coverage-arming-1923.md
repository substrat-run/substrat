---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/router': minor
---

The field-coverage walk is now switched on by the router, per request, instead of by a setting on each vertical (#1923).

- The router gains an optional `FIELD_COVERAGE_SAMPLE_RATE`, a decimal in `(0, 1]` (`0.01` is one request in a hundred). It is off when absent or set to anything else, including a value above one. On a request inside the sample, the router mints a dispatch id, sends it as `x-substrat-field-coverage` beside its signed assertion, and writes it on its own request line. Changing the rate, or turning it off, never needs a vertical to be pushed again.
- The stamp honours that header only when its value is a dispatch id and the request's router assertion verifies. A request that did not come through the router, or whose signature is wrong, is never walked. The invocation line carries the id as `fieldCoverageId` beside `outputFields`. `fieldCoverageArmed(request)` answers whether a request is armed, and the operation routes and the MCP door both read it.
- `FIELD_COVERAGE_BINDING` is removed from `@substrat-run/contracts`. Nothing set it. `FIELD_COVERAGE_HEADER` and `FIELD_COVERAGE_ID_FIELD` replace it.
- `tallyFieldCoverage` in `@substrat-run/control-plane-api` is the one way to read the reports. It counts per operation and field for one tenant and one app, and only reports whose dispatch id the router's own line names for that tenant and app, once each. It refuses malformed or oversized reports and keeps nothing per request.
- Log reads (tenant logs, service logs and request records) no longer return a line's `outputFields` or `fieldCoverageId`.
- The platform's own worker script names are reserved (`PLATFORM_SCRIPT_NAMES`). A vertical slug that would deploy under one, such as `substrat/router`, is refused when it is registered and when it is deployed. `verticalScriptStem` is the one place a slug becomes a script name.

A vertical's operations are walked only after it upgrades and pushes again, since the walk runs in its bundled `vertical-host`. The platform's entry carries the new stamp on the next platform deploy.
