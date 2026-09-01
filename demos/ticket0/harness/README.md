# harness

Everything in here runs **outside** an operation: it fetches, it listens on a port, it
calls a model. Module code may do none of those things.

It lives in its own directory rather than beside `src/` because that is the honest way
to say so. `boundary-lint` exempts harness by an allowlist of *filenames* — `seed.ts`,
`server.ts`, `worker.ts` — and adding `assistant.ts` or `kb-ingest.ts` to a list shared
by every vertical would silently stop linting a file that, in somebody else's app, is
genuinely module code. A directory the linter does not walk says the same thing without
making that trade.

| File | What it is |
|---|---|
| `widget-surface.ts` | ticket0's three `/widget/*` routes, mounted on `vertical-host`'s `mountPublicSurface` — which owns the platform half (unauthenticated mount as a declared service, async CORS, the preflight, refusing an unlisted origin before the handler) since #936. |
| `assistant.ts` | The model call — through the platform's model host (`@substrat-run/vertical-host/model`), or an offline extractive fallback — plus the retrieve → record → try-to-send flow. |
| `kb-ingest.ts` | Fetches and parses a documentation corpus into citable articles. |
| `demo-site.ts` | Two fake customer websites, so the widget's calls are genuinely cross-origin. |
| `invites.ts` | How a second person reaches this desk: mint a principal, grant it a role, hand back a one-time link. Mounted by both hosts, because a flow that exists only in the deployment nobody runs locally cannot be demoed or tested. |
| `dev-invites.ts` | The node half of that — a file-backed pending-invite store and the identity link an acceptance makes, standing in for the worker's identity DO. |

Both `assistant.ts` and `kb-ingest.ts` are **connector-shaped**: they run outside the
scope's transaction and come back in through ordinary operations. In a hosted deployment
they are registered connectors; here they are functions the server calls. The operations
at either end are identical, which is the point.
