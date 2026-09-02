---
'@substrat-run/control-plane-api': patch
'@substrat-run/vertical-host': patch
'@substrat-run/contracts': patch
---

Two production defects in the MCP surface, both found by probing the live endpoint rather than by any test, and both invisible to a test suite by construction.

**A 401 carried no `WWW-Authenticate`.** The challenge was attached to a prepared response and thrown as an `HTTPException`, relying on `problemResponse` handing it back untouched. In a workspace that works; in a pushed BUNDLE it did not, because `err instanceof HTTPException` compares against whichever copy of `hono/http-exception` the bundler gave each package — two copies, and the check is false for a genuine exception. The prepared response was discarded and the document rebuilt from an exception carrying no message, which is exactly what production served: a 401 with an empty `detail` and no challenge, so no client could ever start its authorization flow. The handler now returns the response it built instead of routing it through an error path, reads a status structurally rather than by `instanceof`, and normalises a foreign exception before rendering. `problemResponse` recognises an attached response structurally too, so every route that attaches a redirect or a challenge keeps the guarantee its documentation makes.

The same `instanceof` also decided whether a 401 from an operation travelled on as a transport failure or was swallowed into an in-band tool result — the inverse bug, reporting "who are you" as something an agent should work around.

**The RFC 9728 document was never served.** It mounts at `/.well-known/oauth-protected-resource/*` because the spec requires the origin root, and a pushed vertical's manifest listed only its own prefixes in `runWorkerFirst` — so Cloudflare's asset layer answered from the edge with `index.html` and the worker was never invoked. A correctly registered route, unreachable, failing one layer below the code where no lint or test can see it. The platform now routes `.well-known` worker-first whatever a vertical declared (`PLATFORM_WORKER_FIRST_PREFIXES`): a `.well-known` URI is a protocol surface, never an app asset. A vertical that mounts nothing there is unaffected — its own catch-all answers the 404 the asset layer would have.
