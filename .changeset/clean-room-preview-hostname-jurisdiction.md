---
"@substrat-run/control-plane-api": patch
---

fix(previews): mint clean-room preview hostnames under the jurisdiction base

A clean-room (empty, source-less) preview — the shape behind a long-lived test
environment — derived its `--<tag>` URL from `platformBaseDomains[0]`, which in
production is the bare apex `substrat.run`. The wildcard DNS/cert lives on
`*.global.substrat.run`, so the minted hostname
(`crm-eff-<tenant>--test.substrat.run`) resolved to NXDOMAIN and the environment was
unreachable. Mint under `<label>.<jurisdiction>.<baseDomain>` instead — exactly as
provisioning does — so the URL lands on the wildcard. The regression was masked by a
test configured with a single, already-jurisdiction-qualified base; the test now uses
the production shape (bare apex first) and asserts the `.global.` segment is present.
