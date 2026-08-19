---
status: built
layer: plan
description: One login, many teams; team = tenant.
---

# Multiple teams in the Dashboard

**Status:** Phases 1–3 built (switcher, create-team, onboarding, invites + roster). Two
follow-ups flagged (§8). Extends
[dashboard.md](dashboard.md) (the tenant-facing surface) and [membership.md](membership.md)
(orgs, invites, the role-definition/assignment split). The prompt: *let one user create
several teams and invite others; the team scopes the whole portal — billing, apps, domains.*

## 1. Team = tenant

A **team is a tenant**. This is the mapping [dashboard.md §2](dashboard.md) already draws
(Vercel team → Substrat tenant): apps are scopes in the tenant, domains are hostname
bindings under it, the plan is its entitlements. So "the team changes the entire portal"
is not something we build — it falls out of routing every request by `(tenantId, scopeId)`.
Switching team just changes which tenant the request resolves to; every downstream handler
already keys off `node.tenantId`.

"Team members" is the roster *within* one tenant — principals with role assignments at the
tenant node. That is the existing `Team` view (`apps/dashboard/web/src/views/Team.tsx`),
today mock. It is not the switcher; the switcher moves *between* tenants.

## 2. The kernel already supports one login in many teams

The load-bearing fact: the identity directory is already multi-tenant per login. The K-22
migration (`packages/adapter-sqlite/src/index.ts`, `ensureIdentityKey`) rekeyed
`_substrat_identities` to `PRIMARY KEY (tenant_id, provider, external_id)`. So one AuthHero
`sub` gets a **distinct row — and a distinct principal — per tenant**, and
`listIdentityTenants(provider, externalId)` returns *all* of them. The dashboard registers
the pool with `topology: 'central'` (same external id = same person across tenants), so this
is live, not theoretical.

> This supersedes [membership.md §9](membership.md)'s "a person in two tenants is not
> representable." That gap was closed by K-22; §9 predates it.

What the dashboard did *not* do was let the user choose: `resolveAccount` took `tenants[0]`.
Multi-team is therefore mostly a **dashboard + thin control-plane-surface** feature, not a
kernel change.

## 3. It does not create a DO per team

Durable Objects are per **scope**, not per tenant.

- **Directory / tenancy state** — the tenant record, memberships, identity links,
  entitlements, hostname bindings — are rows in the **singleton `control-plane` DO**
  (`host.ts`, resolved by the fixed name `'control-plane'`), keyed by `tenant_id`. Creating
  a team, inviting a member, switching team = rows there. No new DO.
- **Scopes** are one DO each (`scopeNs.get(scopeNs.idFromName(scopeId))`) — the per-tenant
  data-isolation boundary.

So a team costs **one dashboard-scope DO + one DO per app it runs**. The team itself is
directory rows. Switching is free.

## 4. Phase 1 — the switcher (built)

The selected team travels in an `sb_team` cookie, kept **separate from the `sb_session`
OIDC cookie** so a switch never touches the login.

- `sb_team` is **not a security boundary.** Every read re-verifies the named team is in
  `listIdentityTenants(sub)`; a forged value can only ever name a team you already belong
  to, and otherwise falls back to your default team. So the cookie needs no signing — the
  membership check is the gate. (Contrast the provisioning rule in [dashboard.md §4](dashboard.md):
  the tenant is never a *client-supplied argument* to a mutation; here the client only
  *proposes* a selection that the server resolves to a verified membership before it becomes
  `node.tenantId`.)
- `resolveAccount(host, env, sessionToken, selectedTeamId?)` picks
  `tenants.find(x => x === selectedTeamId) ?? tenants[0]`.
- `GET /api/me` returns `{ …, teams: Team[], currentTeamId }`; `POST /api/teams/switch`
  validates membership, sets the cookie, and the client reloads so the whole portal
  re-scopes.
- UI: a switcher under the wordmark in `DashShell` lists every team with a checkmark on the
  current; it is where "New team" (Phase 2) will live.

Bootstrap-on-first-login is unchanged: a login with zero teams still gets one provisioned.

## 5. Phase 2 — create a team + onboarding (built)

`createTeam(name)` (worker.ts) mints tenant + dashboard scope + owner via the existing
`provisionDashboard`, then `linkIdentity`s the **current** `sub` as owner of the new tenant (a
second identities row) and points `sb_team` at it. `POST /api/teams` backs both the in-app
"New team" dialog (in the switcher) and signup onboarding — one endpoint, since creating your
first team and your fifth are the same move.

**Signup is now explicit, not silent.** `resolveAccount` no longer bootstraps a tenant as a
side effect of resolving who you are (that was the old `tenants[0]`-or-create branch); it is
read-only. `GET /api/me` has three states: no session → 401; a session with **zero teams** →
`{ needsOnboarding: true }` (the app shows a "name your team" card, replacing today's silent
email-domain bootstrap); otherwise the resolved node + team list. A teamless login is never
auto-provisioned — it must name its first team.

Roles are unchanged: a created team still defines only the shipped `owner` role, so **no
permission-diff checkpoint** here. Member roles (`admin`/`member`/`viewer`) arrive with
Phase 3. Resolving pending invites at signup (so an invited user lands in the inviting team,
not a fresh one) is deferred to Phase 3 with the rest of the invite machinery.

## 6. Phase 3 — invites + real members roster (built)

The **real invites engine** (`engines/invites`) is composed into the dashboard vertical (star
topology, never a fork); both modules run in the dashboard scope, and the team gets an
`invites` entitlement + a default org to key invitations on.

- **Roles.** `MEMBER_ROLES` (module.ts) defines `owner` / `admin` / `member` / `viewer`;
  `provision.ts` renders `ROLES` from it, so PERMISSIONS.md and the runtime `assignRole` set
  agree. New permission `dashboard:manage-members` + the engine's `invites:*`.
- **The §5.1 bound is enforced in the dashboard, because the kernel does not.** `assignRole`
  takes a `PlatformActorId` and performs no escalation check (confirmed in both adapters). So
  `dashboard/invite-member` checks, for each permission the target role carries, that the
  *inviter* holds it (`ctx.check`) — a member cannot mint authority above their own.
- **Roster is the dashboard's own projection** (`dashboard_members`): there is no kernel
  "who holds a role here" query. It also holds the invitee's plaintext email (the engine
  hashes identifiers) — the admin legitimately sees whom they invited; non-enumerability
  protects the *accept* path and cross-tenant correlation, not the owner's view of their team.
- **Accept flow.** An invite returns a signed token (`{tenantId, scopeId, invitationId}`, HMAC
  over `SESSION_SECRET`) in a `/invite/<token>` link. The recipient logs in (verified email);
  the worker mints their principal, invokes `dashboard/accept-invite` (which composes
  `acceptInvite` — the engine **re-hashes their verified email**, the real gate — and flips the
  roster row active), then effects access: `assignRole` at the tenant node + a `linkIdentity`
  so future logins land in the team. Idempotent: an existing member just switches; a settled
  invitation fails at the engine. Executors run inline-after-commit, so there is no async gap.

**Checkpoints tripped (both human-read-a-diff gates):** the `0003-members` migration
(dashboard_members + dashboard_team) plus the composed invites migration (migration diff), and
the new keys/roles in PERMISSIONS.md (permission diff — regenerated, `--check`-clean).

## 7. Member removal — the kernel gained `unassignRole`

Removing an active member needs to *revoke a role assignment*, which the kernel could not do —
it had `assignRole` but no inverse (only org-membership tombstones, which do not cut role-based
access). So this work **added `unassignRole` to the kernel**: `ScopeHost.HostAdmin.unassignRole`
+ both adapters (tombstone the role tuple — K-21, never DELETE, so the checker skips it and a
re-`assignRole` reactivates), a generic tenant-tuple/scope-tuple revoke on the Cloudflare DOs, the
`unassignRole` admin-log action, and a contract-suite test. `dashboard/remove-member` marks the
roster row revoked and the worker calls `unassignRole` (access is actually cut) **and
`unlinkIdentity`** (severs their login from the team, so it also leaves their own switcher rather
than lingering as a dead entry); the owner cannot be removed. `unlinkIdentity` (keyed by principal,
so the remover needs no external subject) is a DELETE — the identity map is current state, the audit
is the admin log — so a re-invite can re-link a fresh principal. Both kernel additions ship with
contract/adapter tests.

## 8. Email delivery — landed after this doc

Written when an invite returned only a **shareable link** the inviter passed along. That
follow-up has since shipped (#511): `packages/adapter-email` is the notification-transport
port (Cloudflare Email Service binding, mock fallback so a missing binding never fails an
invite), and the dashboard sends the invite email in the request path
(`apps/dashboard/src/email.ts` — the only place the plaintext address exists; `invites.sent`
still carries a hash). The copy-link affordance remains as the fallback.

## 9. Out of scope for this line of work

Seat/member-count billing. Entitlements are boolean SKU flags per tenant; per-member metering
is net-new ([membership.md §7](membership.md)). Billing and domains views re-scope per team
for free but stay mock until separately taken up.
