# Control plane

The **shared directory** every vertical registers against — the one deployment the whole platform
has in common. A singleton `ControlPlaneDO` (tenant registry, scope lifecycle, entitlements,
roles, identities, the append-only admin audit log) fronted by the audited
`createControlPlaneApi` HTTP surface. Verticals register their tenant/scope here; the
[Console](/platform/console) reads and acts through it; the [Router](/platform/router) resolves
hostnames against it.

Nothing domain-shaped runs here. It owns no engine, no vertical tables — only the directory. (A
module-less `ScopeDO` binding exists solely because the coordinator's `provisionScope` still
instantiates one; decoupling that is later work.)

## Where it sits

It is the concrete form of the [platform layer](/concepts/platform): the durable authority for
[tenancy](/concepts/tenancy) and, at write time, [permissions](/concepts/permissions#where-tuples-live-a-scope-reads-only-its-own-state).
Under scope-local permissions it is a **write-time** authority that projects roles and
tenant-level tuples into scopes — deliberately *off* the request hot path, so a scope never reads
it to answer a permission check.

The transport in front of the DO is [`@substrat-run/control-plane-api`](https://github.com/substrat-run/substrat/tree/main/packages/control-plane-api)
— the audited `HostAdmin` surface, the same one the CLI's deploy endpoint and the Console call.

## What it manages now

Beyond the base registry, a few capabilities have landed that are worth naming:

- **Tenant delete with a grace window.** `deleting` is a reversible, read-closed containment state that
  stamps `deletingAt`; a scheduled **grace-window sweep** ages the tenant off that timestamp and then
  `reapTenant` clears the directory PII/config rows (identities, membership tuples, roles, entitlements,
  orgs) while keeping the `tenants` row as a burned-slug tombstone and the admin log whole.
- **Reaping an archived scope's DO storage.** Cloudflare never garbage-collects a Durable Object, so
  `reapScope` (archived → reaped) wipes the scope DO's storage explicitly — an archived app stops
  costing storage only once it is reaped.
- **Entitlements delivered with provisioning.** Entitlements are per-tenant SKU flags the kernel enforces
  per operation (`manifest.entitlementKey`); a scope reads its currently-held entitlements at request
  time, and the control plane is what projects them.
- **The hosted-vertical sandbox as a positive allowlist.** A pushed vertical's declared bindings are
  checked against a positive allowlist (`ADMISSIBLE_BINDING_TYPES`) — anything not named is refused. It
  is this sandbox contract, not a staff read of an opaque digest, that lets a **private** vertical's
  version land admitted automatically (its blast radius is its own tenant).
- **Platform-mediated egress: the email relay.** The sandbox refuses *egress-shaped* bindings on
  purpose — `send_email`, `ai`, `browser`, and friends stay off the allowlist because reaching the
  outside world is a platform concern, not a per-vertical one (and a Workers-for-Platforms dispatch
  script cannot bind `send_email` anyway). So a vertical never sends mail directly. Instead it POSTs to
  the control plane's `POST /internal/email/send` **relay**, and the control plane — the one worker that
  holds an outbound-mail credential — sends on its behalf, but **only** if that vertical holds the
  staff-granted `emailSender` capability. This is the general shape for giving a hosted vertical a
  privileged capability without handing it the credential: a manifest *request* (`substrat.sendsEmail`),
  a staff *grant* (`setVerticalEmailSender`, the twin of the tenant-provisioner grant), and a
  platform-held relay that checks the grant on every call. Authentication reuses the `PLATFORM_SECRET`
  the uploader already injects into every dispatch script; the relay re-derives *which* vertical is
  calling from the named `(tenant, scope)` and checks the grant against that, so holding the shared
  secret is not enough. The `from` address is always the platform's onboarded sender.

## Auth posture — fail closed

Secure by default: a real `wrangler deploy` sets no dev-actor escape hatch, so every request
**fails closed (401)** until authenticated. Locally, `pnpm --filter @substrat-run/control-plane dev`
turns on `ALLOW_DEV_ACTOR` and trusts an `x-platform-actor` header as a stand-in — never mounted
in production.

Who may act is data, not config: the `staff_actor` table in D1 holds one `PlatformActorId` per
human, so the admin log can name *who* suspended a tenant. Access is revoked with a **tombstone**,
never a `DELETE` (K-21) — the row is the evidence that access was once granted, which is what an
audit asks for. An empty roster means nobody can act; fail-closed is the correct posture. The
roster also gates staff account creation, so a departed operator cannot simply re-register.

The one honest gap: staff auth is still email + password with no MFA and no SSO, on a surface that
can suspend every tenant. That is a tracked open question, not a settled design.

## Run it

```sh
pnpm --filter @substrat-run/control-plane dev     # wrangler dev, no account; ALLOW_DEV_ACTOR on
pnpm --filter @substrat-run/control-plane test    # workerd test
pnpm --filter @substrat-run/control-plane deploy   # Workers Paid plan (DO SQLite)
```
