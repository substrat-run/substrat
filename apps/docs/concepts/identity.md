# Authentication &amp; identity

The kernel **authorizes**; it never **authenticates**. Every operation runs against an
ambient `PrincipalId` that is already established by the time the kernel sees it — the
kernel never learns *how* a caller proved who they are, only *who they are*. Authentication
is a swappable adapter at the edge (decision D-16).

## The line: authenticate vs authorize

- **Authorization is the kernel's** — roles, grants, tenancy, the tuple evaluator
  ([permissions](/concepts/permissions)). This is enforced on every operation and cannot be
  delegated to an outside system.
- **Authentication is an adapter's** — it takes a request (a session cookie, a bearer token,
  an OIDC `sub`) and resolves it to a `PrincipalId` + home node. Nothing more.
- An external IdP's **organizations/roles are a projection** of kernel tuples, never the
  source of truth. If you let an IdP's RBAC decide access, you have two permission systems
  fighting — exactly what the three-layer rule forbids.

## The neutral seam

The control-plane directory holds one provider-agnostic mapping:

```sql
_substrat_identities (
  provider     TEXT,   -- 'better-auth' | 'oidc:<issuer>' | …
  external_id  TEXT,   -- the provider's stable user id (e.g. the OIDC `sub`)
  principal_id TEXT,   -- the Substrat principal it resolves to
  tenant_id    TEXT,
  scope_id     TEXT,   -- NULL = tenant-level home
  PRIMARY KEY (tenant_id, provider, external_id)
)
```

exposed on the host admin as a small write/read surface:

```ts
linkIdentity(actor, { provider, externalId, principal, tenantId, scopeId? }): void // audited; idempotent per (tenantId, provider, externalId)
unlinkIdentity(actor, tenantId, principal): void   // audited; severs a principal's login — keyed by principal, a hard delete (the admin log is the audit)
listIdentityLinks(actor, tenantId): IdentityLink[] // access-logged; one tenant's links — the projection/provisioning gather
resolveIdentity(tenantId, provider, externalId): { principal, scopeId } | undefined // the auth adapter's read; machine path, not logged
```

Because the mapping is **keyed by provider**, several auth adapters — and several OIDC
upstreams — coexist without collision. Adding one is additive: no schema change, no
permission, no kernel change.

**Pools are registered, and declare their topology.** Before a provider may link
anything it registers as `central` (one pool serving many tenants — the same
`externalId` everywhere is the same human) or `tenant-bound` (one pool, one tenant —
the same `externalId` elsewhere is a *different* human). An unregistered provider is
refused rather than defaulted: without that fact the kernel would be guessing whether
two people are one.

```ts
await host.admin.registerIdentityPool(actor, {
  provider: 'oidc:https://issuer.example',
  topology: 'tenant-bound',
  tenantId,                       // null for a central pool
});
```

Topology, not audience. A padel player on a branded multi-club platform is a *consumer*
who wants the central topology, while a shopper on a white-label store is a consumer who
must not have it — so the audience is shorthand and the topology is the enforceable fact.
A provider string names exactly one pool, so separate per-tenant deployments take
distinct provider strings (`oidc:<issuer>`).

**And keyed by tenant.** The full key is `(tenantId, provider, externalId)`, with the
tenant as an *input* to the lookup rather than something derived from the identity. That
matters as soon as tenants have their own identity pools: an external subject id is unique
only *within* its pool, so two white-label shops can both issue user `123` to different
people. A globally-keyed mapping would resolve the second as the first.

The same key is what lets one login belong to several tenants — a consultant
administering five customers is one external identity with one row per tenant, and one
principal per tenant. Shared identity, separate authority.

The caller always knows which tenant it is asking about: the request arrived on that
tenant's hostname, or carried a pool-scoped token.

**"Which tenants is this login in?"** is a separate call, and central-only:

```ts
await host.admin.listIdentityTenants(actor, provider, externalId); // → TenantId[]
```

It throws on a tenant-bound pool. Not because the answer would leak — the caller already
knows that pool's tenant — but because asking is a category error: where the same
`externalId` names different people per tenant, a tenant list has no meaning. Enumerate,
then resolve within the one you picked.

## Resolving without a control plane: the identity projection

`resolveIdentity` lives on the admin surface — which a **CP-less** vertical (its own
Workers-for-Platforms script, no control-plane binding) does not have. Before the
projection landed, such a vertical's only option was a login map compiled into its
bundle: offboarding required a deploy, promoting an older version silently resurrected a
removed login, and whoever could push code could rewrite who resolves to which principal
with no audit trail.

Identity links are therefore **projected into scopes**, exactly as roles, tenant tuples,
and entitlements already are: the control plane stays the audited source of truth, every
`linkIdentity`/`unlinkIdentity` fans the tenant's current links out into its scopes'
`_substrat_identity_links` tables, and CP-less verticals receive them **with
provisioning/reconcile** — the platform gathers them itself (`listIdentityLinks`), never
trusting the caller's body. At request time the auth adapter resolves from the scope's
own storage:

```ts
// The CP-less equivalent of resolveIdentity — same machine-path exemption, reads only
// what the platform projected into this scope.
await host.resolveIdentityLocal(tenantId, scopeId, provider, externalId);
// → { principal, scopeId } | undefined
```

The projection is a full-replace snapshot with no tombstones — an unlinked identity is
simply *absent* from the next snapshot, and absence resolves to nothing. That direction
is deliberate: a stale or missing projection can only ever refuse a legitimate login
(fixable by a reconcile), never admit a revoked one. Offboarding becomes an `unlinkIdentity`
call with durable effect — no deploy, and no version rollback can undo it.

An auth adapter is anything that turns a request into a principal:

```ts
interface AuthAdapter {
  resolve(headers: Headers): Promise<AuthResult | null>; // null = "not mine"
}
```

The server tries its mounted adapters in order; the first to recognise the request wins,
and the resolved principal is handed to `getScope`. Adapters are **chosen by config**, so a
deployment can run one, another, or several at once:

```
AUTH=better-auth,public    # a real session, else an anonymous browse-only fallback
AUTH=oidc                  # an OIDC / authhero adapter
AUTH=better-auth,oidc      # both doors — resolve to the same principal model underneath
```

**OIDC is not a separate burden.** Better Auth can federate upstream identity itself
(social, generic OIDC, enterprise SSO), so "log in with authhero/Google/SSO" becomes
config on the *same* adapter — or a second adapter against the *same* `resolveIdentity`.
Either way the kernel is untouched: doing the seam neutrally is what buys the choice.

### Two real choices, made differently

The neutral seam is not hypothetical — the codebase exercises both ends of it deliberately:

- **The platform's own apps** — the [Dashboard](/platform/dashboard) and the
  [control-plane Console](/platform/console) — authenticate against **AuthHero OIDC**
  (Authorization-Code + PKCE) through the shared
  [`@substrat-run/oidc-rp`](/reference/oidc-rp) relying party. One IdP, one session model,
  across every platform surface — including the `substrat login` CLI, which brokers the same
  flow. This is the "log in with SSO" corner, chosen because platform staff and tenant admins
  are one identity population the platform runs itself.
- **The demos stay on Better Auth**, each with its own user store, because a demo vertical
  models a business that owns *its* customers' logins. Same `AuthAdapter` contract, opposite
  end of the choice.

That the same kernel serves both, unchanged, is the seam paying out.

## Identity sync on first login

The first time an adapter resolves an external user it hasn't seen, it provisions them —
the plan's §4.3 flow — then binds the identity:

1. mint a `PrincipalId`;
2. assign the role(s) that user should hold;
3. create the domain records they own (e.g. a customer);
4. issue any entity-narrowed grants (e.g. read-your-own-orders);
5. `linkIdentity((tenantId, provider, externalId) → principal)`.

From then on `resolveIdentity` short-circuits to the same principal — a stable identity with
real, enforced permissions.

## In the demo

The [Kallkälla Kaffe](https://github.com/substrat-run/substrat/tree/main/demos/shop) shop
uses **Better Auth** as its first adapter (email/password, its own store, entirely separate
from the scope-host DBs) plus a browse-only anonymous fallback. Pre-seeded logins let you
sign in as each persona and *feel* the permission model — the credentials are below.

| Log in as | Password | Role | Sees |
|---|---|---|---|
| `astrid@kallkalla.se` | `demo1234` | shop-admin | everything — catalogue, stock, orders, invoicing |
| `gustav@kallkalla.se` | `demo1234` | warehouse | orders + stock; **invoicing is denied** |
| `elin@cafepascal.se` | `demo1234` | customer | the shop + **only her own** orders |
| `otto@kontoret.se` | `demo1234` | customer | the shop + only his own orders |
| *sign up* | — | customer | a fresh principal, provisioned on first login |
| *(not logged in)* | — | public | browse the catalogue only |

Signing in as Gustav and watching *Invoice basis* disappear from the nav — and 403 if you
ask for it directly — is the whole thesis in one click: **Better Auth authenticated you, the
kernel authorized you.**
