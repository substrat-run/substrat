---
'@substrat-run/boundary-lint': patch
---

`substrat-boundary-lint` is now a checked-in launcher rather than `dist/cli.js` directly. A
package manager creates the bin symlink at **install** time, when a workspace copy of this
package has no `dist` yet — so in any repo that installs before it builds, the bin was silently
never linked and `substrat-boundary-lint` came back "not found" later in the same job. Published
installs are unaffected; the tarball carries `dist` and the launcher just forwards to it.
