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
findings went first, then the Apps read side (list, install steps, events, audit): the cookie routes initially answered beside the declared ones. Those twins have now been removed after the SPA callers moved. The Apps lifecycle writes (install, remove, retry, resume) went next, and for them the cookie routes are gone rather than kept: the SPA's one caller of each moved to `teamApi(teamId)`, so nothing was left to coexist for. The app grid's own list (first load, refresh, "Load more") reads through `teamApi(teamId)` too, so a tab never lists one team's apps while writing to another's; the Domains view's app picker reads it the same way, which left the cookie list route with no caller, so it is gone. Each acts in the team its path names and still asks that team's `dashboard:provision-app` of the caller; `remove` now answers `200 {"removed": true}` where the cookie route answered an empty `204`, because a declared route owes an output. The Domains area went after them (the team's custom domains: list, add, verify, remove; and each app's hostnames: list, bind, unbind), again with no cookie twin, because the Domains view and the app's Domains tab were their only callers; every one still gets its permission check from where it had it (the app-level binds from `dashboard:provision-app` in the caller's role, the team-level ones from the control plane's team narrowing). The team's members and invites went next (the roster; invite, resend, copy link and withdraw an invite; remove a member; leave the team), again with no cookie twin, because the Team view was their only caller and nothing called leave at all. Each invokes the dashboard-scope operation the cookie route invoked, as the caller, so the checks are where they were: the roster is `dashboard:read`, every invite move is `dashboard:manage-members` plus, where a role is granted, every permission that role carries, removal is manage-members plus the removed member's role, and leaving asks only membership. Three answers changed shape because a declared route owes one output at one status: withdrawing an invite answers `200 {"revoked": true}` and leaving `200 {"left": true}` where the cookie routes answered an empty `204`, and removing a member answers `200 {"removed", "pending"}` where it answered `204` done or `202 {"pending": true}`; a `409` refusal is unchanged, and `removed: false` now says that there was no removable member by that id, which the old `204` did not. Leaving clears `sb_team` only when it names the team being left: the cookie route could only leave the team the cookie resolved to, while the path can name any of the caller's teams, and leaving one must not forget another as the last team used. Team deletion stays on the cookie with Settings. Deployments and previews went after them (the verticals the team pushed and their promote, promote-review, channel-history, failures, releases, traffic and issues reads; delete; the installs a vertical still backs with Move and Retire; and a vertical's previews with their custom domains), again with no cookie twin, because the Verticals pages and the app's Deployments tab were their only callers. Each resolves its vertical against the path team's own, so a vertical another team pushed answers exactly as one that does not exist, and the writes ask the role first (`dashboard/authorize-scope-change`, #1595) before anything reaches the plane. Promote keeps its bound acknowledgement untouched (#2335). A declared route owes one output at one status, and parses it on the way out, so these answers changed shape: promote answers `200 {"promoted": true}` and delete `200 {"removed": true}` where the cookie routes answered an empty `204`; creating a preview answers `201` whether it made one or re-bound the tag (`reused: true` in the body says which; the cookie route answered `200` for a re-bound tag); the failures read keeps its eight display fields where the cookie route also passed the plane's actor, tenant and fingerprint columns through; the preview-domain answer is the binding the plane's typed seam names (it no longer carries the tenant id or the vertical slug); `traffic?hours=` is a whole number of hours from 1 to 72, and anything else is a `400` where the cookie route clamped or fell back to 24; the promote review's registries always carry `entityGrants` (`[]` for none); and a malformed body or query is a `400` before the role is asked, where a viewer sending one used to get the `403` first. GitHub import went after observability and team deletion (connect, the repo and branch pickers, one-click CI setup), with no cookie twin, because the Verticals page was their only caller. It was the last area where the cookie decided where a write landed: a tab on one team could connect GitHub to another, and wire a repo's CI to push into it. Connecting and setting up CI ask `dashboard:manage-integrations` in the path team's scope, as before. Connect answers `200 {"url"}` and the page navigates there, because a declared route answers JSON, not a redirect. The install callback stays outside the prefix, as an OAuth callback must, and takes its team from the signed state it was issued with, never from the cookie, which another tab may have moved while this one was on GitHub. It then points `sb_team` at that team, so the tab comes back to the team it connected. The remaining cookie routes and their reasons are listed below as each area moves.

**One rule for the output of a moved route: it must not report a failure for a write that happened, and a plane newer than the dashboard must not turn a read into an error.** The control plane ships separately, so it can answer a value this dashboard's contracts do not know, and a declared route's output parse would turn that into a failed answer, after the write for a write. Every moved route therefore declares what the plane decides forward-compatibly. An enum the plane owns is a `string` in the output schema, its known values documented, and the page shows a value it does not know as the plane named it: a domain's issuance status and its DNS record types, an admin-log action and an audited change's outcome, a finding's kind, status, severity, resolution, codes and its likely cause's kind, a suppress rule's kind and code, a preview's login status. A finding in a status the inbox has no tab for is in no tab and offers no move. A domain in a status the page does not know can still be checked again. The same holds the other way for a value the dashboard only carries from a plane answer back to the plane: a suppress rule's kind and code are copied from a finding, so the route's input takes them as strings, the plane validates them, and a refusal comes back as the plane's own. An input the page builds from its own vocabulary, such as a tab's status filter or a verdict, stays closed. A block that is only forwarded to a person and whose absence already means "cannot show you this" (a registry, a SQL diff, a version's push origin, a finding's evidence or likely cause) reads as `null` when it cannot be parsed. The promote review is the case that matters: `null` is what makes the dialog ask for the acknowledgement, never "no change", so a value the dashboard cannot read fails closed, and the same goes for the Move review. Each such fallback writes one `dashboard.output-drift` line to the worker log (the output field and the issue paths, never a value), so that contracts falling behind the plane is visible to an operator and not only to the person who saw "cannot show". A binding the plane answers with a field this dashboard does not know keeps its `base` and `digest`: the acknowledgement only ever carries those two, and the registry still recomputes the review it binds. A block whose absence would mean "nothing to worry about", the apps a promotion breaks, is never nulled: it is declared with plain strings and always reaches the dialog as the plane named it. An answer that still falls outside its declared output (a required field missing, an id or an instant malformed) is the host's fault, never the caller's: `mountRoutes` throws it as `internal` (`RouteOutputMismatch`), so the caller gets a `500` with the request id and no `detail`, since the issues describe the schema and are no use to them, and the route and the issue paths (never a value) go to the one `dashboard.request-failed` line.
The app owner seat, owner claim, deployed app roster, and app Identity settings now also use team paths. A request first resolves the path's team membership, then looks up the app in that team's dashboard scope. Member changes still run as the signed-in person through the tenant-narrowed plane and the app's own role checks. Identity reads and writes still ask `dashboard:read` and `dashboard:provision-app` respectively in that scope. Claim-link minting additionally asks the owner/admin-only `dashboard/authorize-restore` gate before it reaches the plane. The three new reads stay outside the dashboard assistant's tools.

The app version and data lifecycle routes now use the path's team too: update, bind,
bookmarks, migrations, release comparison, rewind, export and restore. Each resolves the app
inside that team's dashboard scope before calling the existing operation or plane seam. The
existing app-management, rewind and restore permission checks still guard their writes. The
four moved reads stay outside the dashboard assistant's tools, and their cookie routes are gone.

The app Integrations panel's provider list, connect, disconnect, verify and activity routes now
name the team in the path too. The app lookup stays inside that team's dashboard scope;
connect, disconnect and verify keep the `dashboard/begin-connection` permission check in
that scope. The two activity reads keep the same check through their shared connection
lookup. The old cookie routes are gone. The account-wide Integrations list remains separate
work under #2170.

The app's connect links (mint, list, revoke) followed them. Each acts in the team the path
names and asks `dashboard/begin-connection` in that team's dashboard scope first, so a tab on
one team can no longer mint a link whose signed claim names another. The claim keeps its
shape and the landing and callback that read it are unchanged. Mint and list look the app up
in the path team's scope; revoke finds the dashboard's own link by id there, and an
app-mailed link only under an app of that team. Revoke answers `200 {"revoked": <id>}` where
the cookie route answered an empty `204`, because a declared route owes an output. The list
stays outside the assistant's tools, and the old cookie routes are gone.

The Data browser's table list and pages, event facets and timeline reads, refusal
and dead-letter lists, and read-only SQL console now name the team in the path.
The app or secondary scope is resolved in that team's dashboard scope before the
tenant-narrowed control plane is asked. These reads require `dashboard:read`; the SQL
console's statement remains subject to the kernel read-only gate and adapter check.
The old cookie routes are gone, and the new data-returning GETs are not assistant tools.
The app's flow, field coverage and observations, traffic, failures, and overlays now take
the team from the path. The earlier install steps, events, and app audit reads also dropped
their cookie twins. Each app is looked up in the path team's dashboard scope before any
app-specific plane read; a foreign app or a team the caller has not joined gets a `404`.
The previously offered assistant reads keep their tool names and descriptions, while the
newly declared reads stay outside the assistant. The SPA calls these through `teamApi(teamId)`.

The deployment and version asset, permissions, model, processes, and schedules reads still
use the cookie; they form the next app read slice. The catalog keeps its anonymous contract.
OAuth callbacks and other teamless or signed-state routes do not take their team from the
cookie.

The team-wide reads followed: the account-wide Integrations list, fleet health, the identity
mirror and the GitHub workflow preview are declared under the team path, and the team audit
log, declared earlier, lost its cookie twin. Each is a `404` for a team the caller is not in,
before any downstream read. The Overview, the Apps health table, the app header's verdict and
the Audit page read them through `teamApi(teamId)`. On the Integrations page the Connect
dialog's app list now comes from the same team the dialog connects in, so with the cookie on
another team Connect no longer answers `404 app not found`. The workflow preview depends on no
team at all, but it moved too, so every team route keeps the same membership rule. The four new
reads stay outside the assistant's tools, the audit tool is unchanged, and the cookie routes
are gone.

The app's peer and edge panels, including the Data tab's scope choices, now use team paths.
The three peer and edge writes keep the `dashboard:provision-app` gate in the path team's
dashboard scope. The control plane confines peer bindings to active scopes in that tenant
and resolves an edge's producer through that tenant's directory. The old cookie routes are
gone; the three new reads remain outside the assistant's tools.

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

Seat/member-count billing and per-member metering ([membership.md §7](membership.md)).
The Billing view reads this team's directory entitlements and persisted metered usage
through its team path for an owner or admin. The control plane's new
`GET /tenants/:tenantId/metered-usage` is path-pinned to the same tenant and returns
only scope-database storage samples, estimated daily router requests, and recorded
model calls and provider-reported tokens. It reads at most 30 closed UTC days,
10,000 request rows, and 25 pages of 501 model records. Capped totals are labelled
as partial, with bounded app/model breakdowns. It contains no prices, invoice,
checkout, payment method, spend limit, or person-level usage.
