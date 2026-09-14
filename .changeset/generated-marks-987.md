---
'@substrat-run/psl': patch
---

The rule that a generated file must be recognisable as one is now checked, instead of being written down and hoped for.

A file built from something else is meant to carry three marks: a name that says so, a header naming what produced it and from what, and a check in CI that re-emits it. The third was always enforced — that is what the checks do. The first two were prose, and prose drifted: an audit found six files short of a mark, and the vendored public-suffix data had carried a producer header and no telltale name for a year while the project's own instructions asserted it had both.

Both halves are now checked, in both directions: a file that says it was generated has to be named that way, and a file named that way has to say what produced it. The one it would have caught is fixed — the public-suffix data is renamed, which is a rename of an internal file and changes nothing a consumer imports.

What the check deliberately does not do is guess at the third mark. Whether something re-emits a file is a fact about the build, not about the file, and inferring it from a filename would be exactly the assumption the rule exists to prevent.
