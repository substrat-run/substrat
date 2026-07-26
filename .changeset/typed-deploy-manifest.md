---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': patch
'@substrat-run/cli': patch
---

The deploy manifest becomes a shared contract (#190 part A): `deployManifest` and
`DeclaredBinding` move from `control-plane-api` into `@substrat-run/contracts`, and
BOTH ends of the push seam now speak the same schema — the CLI parses the manifest it
builds with `deployManifest.parse(...)` before uploading, the control plane re-parses
it at the trust boundary and runs the §4 sandbox contract against the result.

Before this, `push.ts` hand-rolled a parallel manifest object against a local
`DeclaredBinding` interface while the server parsed the real Zod schema — a drift
hazard on the deploy trust boundary, where a shape mismatch surfaced only as a 4xx
from the deploy endpoint. Now drift is a compile error (shared types) or a local parse
failure before any bytes are uploaded; a CLI-side effect is that registry metadata
(`envSpec`, `ownerGrants`, `provides`, `requires`) is validated at push time too.

`control-plane-api` re-exports the schema and types unchanged, so hosts keep importing
from the transport package. The CLI gains its first runtime dependency
(`@substrat-run/contracts`) — deliberate: the alternative was the drift. Part B of
#190 (a substrate-neutral `runtimeNeeds` manifest section) stays open, gated on the
product decision the issue describes.
