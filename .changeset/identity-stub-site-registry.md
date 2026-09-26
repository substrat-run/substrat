---
'@substrat-run/vertical-auth': patch
---

`IdentityStub` now carries the site-registry methods (`recordSite`, `forgetSite`, `listSites`, `resolveSiteScope`) the `IdentityDO` class already had, so a worker calling them through the stub type-checks. A type-level pin fails the build if the class and the stub drift apart again.
