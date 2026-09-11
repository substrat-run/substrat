---
'@substrat-run/kernel': minor
'@substrat-run/control-plane-api': minor
---

A team can now read the traffic and logs of an app they installed, even when the vertical
it runs is published by somebody else.

Observability was keyed on the deployed script, and one vertical's script serves every
team that installed it — so those numbers belong to the vertical's builder, and an
installed app's Observability tab could only say so. That is true and it is not an answer
to "how is my app doing", which is a question about the installation rather than the code.

The new tenant grain is keyed on `(tenant, scope)`: the requests the router dispatched to
one app, and the lines that app's vertical wrote while serving them. Two teams running the
same vertical see two different pages, with no overlap.

Two pieces:

- `invocationLog()` (`@substrat-run/kernel`) — a vertical mounts it as its first
  middleware and it writes one structured line per invocation, carrying the tenant and
  scope the router asserted. The path is recorded **without its query string**, since an
  OIDC vertical carries `code` and `state` there and an invite flow carries a single-use
  token. A line is written only when the router asserted a tenant, so there is never a
  line that could be attributed to the wrong one.
- `tenantMetrics` / `tenantLogs` on `ObservabilityReader` — optional, like the other
  backend-dependent reads, and 501 when absent rather than returning an empty array that
  a caller would draw as "your app served nothing". `tenantId` is not a widenable filter:
  it is the narrowing, and the seam has no "all tenants" spelling.

A vertical picks this up on its next push. Until then its app shows traffic (which comes
from the router and needs nothing from the vertical) and no logs; the empty state says
which of the two it is looking at.
