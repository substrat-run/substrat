---
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
---

The dashboard now holds a credential that can only reach your own team, and the platform refuses anything else.

Until now the dashboard presented one platform-wide credential to the control plane and narrowed itself to your team in its own code. The narrowing was real, and it was a promise the dashboard made about itself: nothing on the other side checked it, so it held exactly as long as every one of the dashboard's ninety-odd calls named the right team.

It is now a property of the credential. The control plane mints a **tenant token** per team, the dashboard presents that, and the plane refuses a request that names another team — in the path, in a query, in a body, or in the tenant header a caller sends alongside. Routes the dashboard does not use are refused outright rather than reachable, and routes whose answer is a fact about a vertical or a hostname are narrowed by who owns it. The reads that used to return the whole fleet and get filtered in the dashboard — invocation metrics, log lines — are narrowed before they leave the plane, so another team's numbers no longer cross the seam at all.

The platform credential stays for exactly one thing: asking the plane to mint that per-team token. Minting is refused to a tenant token itself, so a credential can never widen its own reach.

What has **not** changed is who an action is recorded as: the admin log still names the dashboard rather than the person who clicked. The tenant token carries no actor at all, so nothing about it can change that; naming your own admin is a separate change to what an audit row may hold.

**Operators:** set `TENANT_TOKEN_SECRET` on the control plane (a dedicated value — not the push-token secret, not the platform secret) and deploy it **before** the dashboard. A dashboard pointed at a plane that cannot mint says so rather than falling back to the old credential.
