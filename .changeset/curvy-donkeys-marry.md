---
'@substrat-run/contracts': patch
---

`substrat init --ci github` now pins `actions/checkout@v7` and
`actions/setup-node@v6` instead of `@v4` of both, and passes
`persist-credentials: false` to the checkout. A scaffolded project no longer
arrives on action majors two releases behind, and the workflow token no longer
sits in `.git/config` while the job installs and builds — nothing in the
generated workflow speaks git over the network after the checkout.
