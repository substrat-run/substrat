---
'@substrat-run/contracts': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/control-plane': patch
---

When a vertical declares a scope store, its store script is put in place before the vertical itself is uploaded, on a push and on a serve (#2210). The script is a Python worker. Its entry checks the envelope with the same verifier the JavaScript entry uses.

A store kind's registration now pins its releases as D-63 requires: each release is pinned by the sha256 of its bundle (`storeKindReleaseDigest`) and the source commit it was built from. Every upload re-hashes the bytes it is about to send and refuses bytes that are not pinned. A push or a serve never moves a store script to another release. If the platform's entry or a key list changed, a push or serve rebuilds the script at the release it already runs. A kind with no release to run is refused.

A release's modules must sit in one `kind_<name>/` package. A store upload failure is recorded as an ops failure and stops the vertical's upload.
