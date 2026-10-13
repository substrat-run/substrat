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

The dashboard reads it through `listIdentityMemberships`, which is that same enumeration
with each tenant row, principal and linked scope attached — one directory read per request
(`apps/dashboard/src/account.ts`). The resolve used to compose the answer from
`listIdentityTenants` plus a `getTenant` per team, which made every `/api/*` call cost two
directory round trips per team the login was in.

A resolved node is then **reused for 30 seconds** per isolate (`NODE_TTL_MS`), keyed on
the login and the selected team. That number is a revocation window and is short on
purpose. In-scope operations re-check permission on every invoke, so a removed member's
writes are refused at once; what rides on the resolve alone are the control-plane reads,
which go out over the service token narrowed to the resolved tenant, and those a removed
member can keep reading until the entry ages out. The routes that end a membership
(leave, remove member, delete team) drop the entries in the isolate that served them;
any other isolate learns by expiry. `/api/me` never reads the cache — it is the call that
draws the team switcher — and "no team" is never cached, so a login resolves the moment
it has one.

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
  the login's memberships (`listIdentityMemberships(sub)`); a forged value can only ever name a team you already belong
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

**The cookie is being retired as the team a request acts on (#2170).** A cookie is shared by
every tab on the origin, so with two tabs on two teams the tab that switched last decided the
team for both: one tab's shell showed team A while its requests read, and wrote, team B. The
membership check still held, so this was a wrong-team bug, not an isolation hole. The fix is that a
request names its team in its own URL. Routes move into the declared surface
(`apps/dashboard/src/routes.ts`), mounted under `/api/teams/:teamId` by `mountRoutes`. There,
anything but that exact team is a 404, never a fallback to your default team. The browser reaches
them through the generated client, built per team (`teamApi(teamId)`). Areas move one at a time;
findings went first, then the Apps read side (list, install steps, events, audit): the cookie routes
keep answering beside the declared ones and call the same implementation, so the two cannot drift. The Apps lifecycle writes (install, remove, retry, resume) went next, and for them the cookie routes are gone rather than kept: the SPA's one caller of each moved to `teamApi(teamId)`, so nothing was left to coexist for. The app grid's own list (first load, refresh, "Load more") reads through `teamApi(teamId)` too, so a tab never lists one team's apps while writing to another's; the Domains view's app picker reads it the same way, which left the cookie list route with no caller, so it is gone. Each acts in the team its path names and still asks that team's `dashboard:provision-app` of the caller; `remove` now answers `200 {"removed": true}` where the cookie route answered an empty `204`, because a declared route owes an output. The Domains area went after them (the team's custom domains: list, add, verify, remove; and each app's hostnames: list, bind, unbind), again with no cookie twin, because the Domains view and the app's Domains tab were their only callers; every one still gets its permission check from where it had it (the app-level binds from `dashboard:provision-app` in the caller's role, the team-level ones from the control plane's team narrowing). The team's members and invites went next (the roster; invite, resend, copy link and withdraw an invite; remove a member; leave the team), again with no cookie twin, because the Team view was their only caller and nothing called leave at all. Each invokes the dashboard-scope operation the cookie route invoked, as the caller, so the checks are where they were: the roster is `dashboard:read`, every invite move is `dashboard:manage-members` plus, where a role is granted, every permission that role carries, removal is manage-members plus the removed member's role, and leaving asks only membership. Three answers changed shape because a declared route owes one output at one status: withdrawing an invite answers `200 {"revoked": true}` and leaving `200 {"left": true}` where the cookie routes answered an empty `204`, and removing a member answers `200 {"removed", "pending"}` where it answered `204` done or `202 {"pending": true}`; a `409` refusal is unchanged, and `removed: false` now says that there was no removable member by that id, which the old `204` did not. Team deletion stays on the cookie with Settings. What is left on the cookie is every other Apps route (env, members, auth, snapshots, data, integrations), deployments, observability, and settings (team deletion among them): `worker.ts` holds 105 references to `TEAM_COOKIE` after the members slice, from 112. One difference is deliberate: the declared audit routes re-parse the plane's rows with `adminLogEntry` on the way out, where the cookie routes pass them through raw, so a dashboard deployed with older contracts than the control plane (an `adminAction` it does not know) fails that parse on the team routes only. The same holds for the domain routes, with a sharper edge: `addDomainIn` and `listDomainsIn` parse the control plane's row AFTER the plane write, so a dashboard older than the control plane (a hostname `status` it does not know) can answer 500 after the bind has committed. Deploy the dashboard with the contracts that match the plane before the plane ships a new status.
When the last area has moved, `sb_team` survives only as "last team used",
read to decide where `/` lands.

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
