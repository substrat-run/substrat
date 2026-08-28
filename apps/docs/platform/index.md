# The platform surfaces

The [engines](/engines/) and [verticals](/verticals/) are what a tenant *runs*. This section is
the machinery that runs *them* — the deployments and control surfaces that turn "a vertical" into
"a vertical serving a customer at a hostname." Four pieces, each its own deployment:

| Surface | Audience | Answers |
|---|---|---|
| [Control plane](/platform/control-plane) | the platform | the shared directory every vertical registers against — tenants, scopes, roles, entitlements, the admin log |
| [Console](/platform/console) | Substrat operators | *run the platform* — the whole fleet, every tenant, provisioning, the audit log |
| [Router](/platform/router) | inbound traffic | `hostname → (tenant, scope, surface)`, then dispatch — one worker in front of every vertical |
| [Dashboard](/platform/dashboard) | a customer's admin | *run my org* — self-service tenant + apps, seeing only their own tenant |

The split that matters most is **Console vs Dashboard**: same underlying platform, opposite
audience and blast radius. The Console is the operator's back office (all tenants, staff SSO); the
Dashboard is the customer's home (one tenant, customer sign-up). "Console" reads as a back-office
tool; "dashboard" reads as the customer's home — the naming is deliberate, and neither takes the
word "portal", which the docs reserve for a *vertical's* own end-user surface.

These are **private deployments**, not published packages. They are documented here because they
are how the platform actually runs — the same architecture the [concepts](/concepts/platform) and
[reference](/reference/adapter-cloudflare) sections describe, made concrete.

::: tip Where deploy fits
A vertical reaches these surfaces via [`substrat push`](/guide/deploying): the push lands a
version in the control plane — **admitted automatically** for a private vertical, **pending**
for a listed one until an operator admits it in the Console
([who vouches, and why](/concepts/deploying#admission-may-this-code-run-here)) — and the Router
serves it once a scope is bound.
:::
