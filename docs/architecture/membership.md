---
status: built
layer: plan
description: Membership, invites, and the admin as first consumer.
---

# Membership, invites, and the admin as first consumer

**Status:** partly built. Implements plan decision 31; takes the option
[control-plane](control-plane.md) §3 deferred ("decide it at the second vertical").
Built so far: the tombstone with `removeMember`/`listMembers` (#53), the org record and
branded `OrgId` (#55), the connector executor with correlated audit rows (#61), and the
invites engine (#62). Remaining: the tenant-admin surface (§8 step 6).

**K-21** settled revocation (tombstone, never delete) and assignment authority (one
kernel-resolved set comparison, not N checks); both shipped or are recorded inline.
**K-22** settles the seam itself, and **corrects this document**: §4's original sketch of an
in-scope `ctx.members.*` write was wrong, because membership tuples are not scope-local. The
seam is a connector. §4.1 keeps the correction visible rather than quietly rewriting it.

**What this is:** the decision that the Substrat admin's record-keeping half becomes a
vertical, and that the engines it needs — membership, invites, entitlements-as-plan — are
the same engines every hosted vertical needs. Plus the one kernel seam that makes it
possible, and the role-write question that gates self-service.

Read alongside [control-plane](control-plane.md) §3 (what can be a vertical),
[kernel-design](kernel-design.md) §4.2 (the tuple engine) and §4.3 (identity, the three
audiences), and [master-plan](../master-plan.md) D-30.

---

## 1. The finding this starts from

**Substrat's own admin has the same shape as the software it hosts.** It needs members,
invites, roles, a plan with quotas and expiry, metered usage, and an audit trail. So does
every vertical on the platform. Today those are filed as five separate control-plane gaps
(#33, #34, #35, #38, #39), which frames them as platform plumbing that the admin happens
to need.

They are not plumbing. They are product engines with **two consumers**, one of whom is us.

The consequence of not seeing that: members and billing get built twice — once bespoke
inside the control plane, once properly as engines when a vertical needs them — and the
bespoke one will not be the reusable one, because nothing forced it to be. This is the
same argument §2 made about the console ("not a feature on a finished kernel; it is what
forces the shared layer to exist"), applied one level up.

It is also the test [master-plan](../master-plan.md) §10 sets for the platform trap —
*"kernel features nobody consumes yet = the trap announcing itself."* Two real consumers
is precisely the condition the trap is defined against. Membership passes that test
today. Metering does not (§7).

## 2. What §3 deferred, and what triggers it now

§3 already concluded that the record-keeping half "can be a vertical, and probably should
be, eventually", and set the trigger as *"when the platform tenant holds enough data to
earn a deployment. Decide it at the second vertical."* It also warned, correctly, against
writing "the admin is never a vertical" into the log.

The trigger fired, but not for the reason §3 predicted. It is not that the platform tenant
accumulated data. It is that **self-service changed the population**: thousands of tenants,
each with a set of members who join, change role, and leave without a human at Substrat
being involved. That makes membership a product surface rather than an ops task, and a
product surface is exactly what a vertical is for.

## 3. The line that does not move

§3's split stands unchanged:

| Half | Where it runs | Why |
|---|---|---|
| **Effecting** — provision, suspend, archive, entitlement flips, hostname issuance, admin-query RPC | Out-of-band host code, always | K-8: module code holds one service binding to its own kernel entrypoint and **never a raw DO namespace binding**. An admin vertical has no addressable path to another vertical's scopes. Not dangerous — **impotent**. |
| **Record-keeping** — tenant registry, plan and contacts, members and roles, the action trail | A vertical in a platform tenant | Ordinary scope-shaped data. Gets the outbox (audit for free), the tuple engine, and migrations from the kernel instead of reimplemented beside it. |

The bridge is unchanged too, and already designed: **D-18's triage rule — effects on the
outside world are connectors.** The control-plane vertical emits
`tenant.provision_requested`; a privileged executor outside module code consumes it, acts
through the host admin surface, and emits the result back. Module code never obtains a
cross-tenant stub. K-3 and K-8 are untouched.

Note that members and metered billing — the two properties that motivated this decision —
both fall on the record-keeping side. The split does not obstruct the case; it bounds it.
Roughly 30% of the admin stays host code.

## 4. The missing seam: membership is unreachable in-scope

This is the new finding, and the reason #34 as currently written would not unblock
self-service.

`OperationContext` is `{ tenantId, scopeId, principal, sql, emit, check, link }`
([scope-host.ts:54-69](../../packages/kernel/src/scope-host.ts#L54-L69)). `link` writes
entity-edge relation tuples (K-16). **There is no membership equivalent.** Membership
lives in the tenant-root DO ([kernel-design](kernel-design.md) §3.2), and module code is
forbidden to write `_substrat_tuples` ([kernel-design](kernel-design.md) §13, open
question 15).

Membership mutation exists only on `HostAdmin`:

```ts
addMember(actor: PlatformActorId, tenantId: TenantId, principal: PrincipalId, orgId: string): Promise<void>
```
([scope-host.ts:189](../../packages/kernel/src/scope-host.ts#L189))

Three things are wrong with that for self-service, in increasing order of severity:

1. **There is no `removeMember` and no member enumeration.** Add-only membership at
   thousands of self-serve tenants is a security incident waiting for its first departing
   employee.
2. **`orgId` is an unvalidated free-form string with no org record behind it.** A tuple
   `principal:X --member--> org:Y` where `org:Y` is whatever the caller typed.
3. **The signature takes a `PlatformActorId`.** This is the structural one. A tenant admin
   is a `PrincipalId`. Even if the route existed, a tenant admin could not call it *as
   themselves* — every self-serve membership change would have to be laundered through a
   platform actor, which destroys the distinction the admin log exists to record. Adding
   `removeMember`/`listMembers` alongside it inherits the same defect.

So the seam is not an HTTP route. But it is **not an in-scope tuple write either** —
which is what the first draft of this section proposed, and it was wrong.

### 4.1 Why not `ctx.members.*` (the correction)

The original sketch was `ctx.members.add/remove/list`, "on the same pattern `ctx.link`
already establishes". That reasoning does not survive contact with where the tuples live.

`ctx.link` works **because entity tuples are scope-local** — same database, same
transaction, same serialization domain, so the write and the next `ctx.check` are trivially
consistent. **Membership tuples are not scope-local.** They are tenant-wide facts living in
the directory ([kernel-design](kernel-design.md) §3.2: the tenant-root DO holds
"directory · membership · entitlements"), and on the Cloudflare adapter the checker reaches
them by RPC to a separate Durable Object.

So an in-scope `ctx.members.add` would be a **cross-DO write from inside a scope
transaction**: two writes, two serialization domains, no coordinator. If the membership
write lands and the scope transaction then rolls back, someone is a member of an org for a
work order that never existed, and nothing unwinds it. That is a partial-failure hazard,
not merely a weaker guarantee.

Moving membership *into* the scope to recover the transaction is worse still: membership is
tenant-wide, so a scope-local copy means N copies of one access fact, and N copies is a
revocation hazard — miss one and access survives. It also breaks the checker, whose rule-4
resolution happens at the tenant level and would need to know which scope to consult before
it knows what the principal belongs to.

### 4.2 The seam is a connector (K-22)

The engine owns the invariant; the effect is a connector — **D-18's triage rule**, and the
same bridge [control-plane](control-plane.md) §3 already specifies between the admin's
effecting and record-keeping halves.

An invite engine owns the state machine and, on accept, emits a fat event inside its own
transaction. A privileged executor outside module code consumes it and effects the
membership through the host admin surface.

```
invite engine (module code)                  executor (out-of-band host code)
  accept()                                     consumes invite.accepted
  └─ ctx.emit('invite.accepted', …)  ──────▶   └─ admin.addMember(…)
     commits WITH the domain write                 writes the admin-log row
```

This is atomic on the side that matters: the event enters the outbox in the same
transaction as the domain write, so a rollback leaves no event and no membership change.
The executor then applies it at-least-once. Module code still never obtains a cross-tenant
stub, so K-3 and K-8 are untouched.

**Prompt dispatch, not a timer.** The executor is driven **inline after commit**, with the
outbox as the durability and retry backstop — the shape local consumer dispatch already
has (in-process after commit, journaled in `_substrat_deliveries`, K-16). The contract stays
eventually consistent, because that is what makes it correct under crash; but the common
case completes inside the request, so "accepted but not yet a member" is a rare-case
fallback rather than the normal experience. A design that answered this with a UI spinner
would be papering over the latency instead of removing it.

**Correlation is specified, not deferred.** The emitted event carries a correlation id and
the executor's admin-log row carries it back, so the two halves of the trail join by
construction. §3 named the split trail as the main thing that gets worse under this
pattern; joining it is cheap to design now and impossible to reconstruct after two years of
uncorrelated rows — which is exactly when someone asks.

### 4.3 Revocation: tombstone, never delete (K-21, shipped)

A revoked tuple keeps its row and gains a `revoked_at` the checker's walk skips. Decided
for *every* relation, membership included, so there is one revocation mechanism rather than
one per relation.

The reasoning is D-32 rather than taste: an operated compliance product pursuing ISO 27001
and SOC 2 Type II has to show both that access was revoked *and* the trail proving it was
once granted, and deletion cannot produce the second. Open question 15's remaining half —
whether the kernel offers `relink` for entity parent edges — composes on top of the
tombstone rather than competing with it, and has no membership analogue.

`removeMember`, `listMembers` and the tombstone shipped in #53. What remains is the org
record (§4.4) and the connector seam above.

### 4.4 `OrgId` is a branded ULID (K-22)

Every id in the system is a branded ULID — `TenantId`, `ScopeId`, `PrincipalId`,
`PlatformActorId`, `EventId`, `DataSubjectId`, `ModuleId`. **`orgId` is the sole exception**,
a bare `string` on all four membership/grant methods, with no record behind it. Two callers
disagreeing about `acme` versus `Acme` silently address two different orgs, and a typo in
`grantToOrg` grants to a phantom nothing will ever reach.

Orgs become a real directory record keyed by a branded `OrgId`, with slug and name as
*attributes* rather than as the identity. That also gives §4.3 of kernel-design the row it
requires — *"the `orgId ↔ tenantId` join is an explicit, stable directory row, one per
tenant, never reconstructed from names or slugs"* — which is why this is shared with #48
rather than local to membership.

Doing it now costs a day. Doing it after production data exists means rewriting every
membership tuple and every org grant, and auditing every access that ever resolved through
one.

## 5. Role definition vs. role assignment

This gates whether invites can exist at all, and it is the piece most likely to be
designed twice if left implicit.

`defineRole` / `assignRole` / `grant` / `grantToOrg` / `addMember` / `linkIdentity` are on
`HostAdmin` and have **no HTTP route**
([api.ts:95-99](../../packages/control-plane-api/src/api.ts#L95-L99)). The stated reason
there is v1 scoping — "the console's v1 job is the tenant registry, lifecycle,
entitlements and history" — not a permanent ban. The permanent principle is the D-22/D-29
permission-diff human checkpoint, and it is narrower than the route absence suggests.

Every invite writes a role assignment. A human cannot read a permission diff per invite
across thousands of tenants. So the checkpoint has to be cut at the right joint:

| | What it is | Who does it | Why it is safe |
|---|---|---|---|
| **Role *definition*** | What permissions a role carries | Stays a reviewed checkpoint — `pnpm lint:permissions`, checked-in `PERMISSIONS.md`, CI-diffed | Changes rarely; it is the vertical's security model. Widening a role must still appear in a PR diff. |
| **Role *assignment*** | Putting a person into an already-defined role | Self-serve, by a tenant admin, gated by an ordinary `ctx.check` | The permission set was reviewed upstream — **provided assignment is bounded by the assigner's own authority (§5.1)**, without which this claim is false. |

This does not weaken D-22/D-29 — it identifies what they were protecting. The checkpoint
exists so that a *widening of what a role can do* cannot merge unseen. Assigning a person
to a reviewed role is a different act, and holding it to the same gate makes self-service
impossible while protecting nothing.

**Corollary:** a self-serve tenant admin may assign from a fixed, vertical-declared role
set and may never call `defineRole`. That is a capability boundary, not a UI convention,
and it should be enforced where the seam in §4 is enforced.

### 5.1 Assignment is bounded by the assigner's own authority

The claim "assignment invents no authority" is **not unconditionally true**, and the
version of this section that omits this subsection is wrong.

Nothing above stops a tenant admin holding `admin` from assigning someone — or
themselves — to `owner`, a role strictly more powerful than their own. No `defineRole`
call is involved, no permission was widened, no diff would show anything, and authority
that review never granted to that person now exists. The moment a vertical defines any
role carrying role-assignment permission, assignment becomes an escalation path and the
checkpoint is back to protecting nothing.

**The rule:** a principal may assign role `R` at node `N` only if the assigner already
holds every permission `R` carries at `N`. You cannot grant what you do not hold. This
makes the safety claim true rather than merely plausible, and it falls out of the same
`ctx.check` the rest of the model uses — no new concept, just a stated bound.

Three consequences worth pinning before implementation:

1. **Removal takes the same bound.** If a junior admin can strip a role they could not
   have granted, they can lock the owner out of their own tenant. Revocation is the
   mirror of assignment, not a lesser act.
2. **Entity-narrowed grants must not launder into unnarrowed roles.** A principal whose
   `workorder.read` is narrowed to one entity (§4.2 rule 3) does not thereby hold
   `workorder.read` for the purposes of this comparison. The bound is over *effective*
   authority at the node, narrowing included.
3. **It needs a permission-set comparison — settled by K-21 as one kernel-resolved
   comparison, not N checks.** `ctx.check` answers one permission at a time and each call
   walks tuples, so checking a 20-permission role would repeat the same walk twenty times
   on every invite acceptance. The kernel resolves the assigner's effective set once and
   compares. *Effective* is narrowing-aware: an entity-narrowed grant does not satisfy the
   bound for the unnarrowed permission, or narrowing would launder into full authority by
   way of assignment. This follows §4.3's rule that the kernel stays the only place "who
   can do what" is enumerable — the comparison is that enumeration turned inward, and
   keeping it there is what stops each vertical hand-rolling its own escalation check.

**Bootstrap.** The rule implies a tenant's first admin cannot assign themselves. It does
not need to: the initial owner is seeded platform-side during provisioning — the effecting
half (§3), which is out-of-band host code and already holds the authority. Self-service
begins at the second member, not the first.

## 6. The invites engine (built)

`@substrat-run/engine-invites`. A state machine that cannot skip states, every mutation
emitting a fat event, every operation checking a permission — except one, and that
exception is the interesting part.

`invited → accepted | revoked | expired`, accept-required, verified hashed identifier,
rate-limited. The mechanics came from [booking-social](../rfc/booking-social.md) §"invite,
don't search" — written for a consumer social graph, and they transferred intact.

**The engine owns the flow; the executor owns the effect.** On accept the engine
*emits* `member.add-requested` and the connector (§4.2) effects it. An earlier draft of
this section said the engine "calls the §4 seam", which was the in-scope framing §4.1
corrects: the engine cannot call anything that writes the directory, because that write
is outside its transaction. It asks. That is why the seam had to exist first — without
it the engine can run its entire state machine and then be unable to make anyone a
member.

**`invites/accept` checks no permission**, deliberately. The recipient is not yet a
member of anything, so there is no grant they could hold; a check would be vacuous or
would require granting access *before* acceptance, which is what accept-required exists
to prevent. The invitation is the authority, proven by re-hashing the identifier the
caller presents — so a leaked invitation id is not a bearer token.

**The identifier hash is salted per scope.** A global salt would make one address
produce one hash everywhere, letting anyone holding the table correlate a person across
tenants — reintroducing what per-tenant identity pools exist to prevent (§4.3). This
was not in the original sketch and is the kind of thing that is free to get right at
build time and unfixable afterwards.

**Extraction discipline (D-27) is satisfied, narrowly.** Engines are extracted at the
second vertical, never designed ahead. Membership and invites have two real consumers on
day one — the admin vertical and the demo verticals — which is the condition, not an
exception to it. This does not license the same reasoning for anything else in this
document.

## 7. Metering: priced, not promised

Declaring the admin a vertical does **not** deliver metered billing, and the case for this
decision should not lean on it.

D-30 is explicit: meters 1 (active scopes) and 2 (entitlements) fall out free; **3 and 4
are uncomputable by construction** — the outbox is per-scope-database and cannot aggregate,
reads emit nothing, `drained_at` is written nowhere. Meter 3 needs the Tier-2 fan-in sink;
meter 4 needs cross-tenant orders. *"A meter you cannot compute is not a pricing decision,
it is a data-pipeline project."*

So metering is the one item here that **fails the two-consumers test**: no vertical meters
anything today. It stays deferred (#38, #39) until one does. Entitlements-as-plan (#33) is
separable — quota, expiry and tier are needed for self-serve signup and need no meters —
and lands with the tenant-admin surface.

Naming this is the honest half of the decision. Admin-as-vertical *forces the metering
substrate to eventually exist*, which is the same forcing-function argument §1 makes — but
with a much larger bill attached, and it should be paid deliberately rather than
discovered.

## 8. Sequencing

1. ~~**This decision** (D-31) and §5's definition/assignment split~~ — done; §5.1's bound
   and K-21 settled the two forks that gated the rest.
2. ~~**Failed-migration visibility (#32)**~~ — shipped (#50). Self-service provisions
   scopes with no human watching, so a silent migration failure meant a tenant signed up,
   received a broken scope, and the fleet rendered it healthy.
3. ~~**Revocation (K-21)**~~ — shipped (#53): the tombstone, `removeMember`, `listMembers`.
   Membership was write-only before it.
4. **The org record (#34, remainder).** `OrgId` becomes a branded ULID and orgs become a
   real directory record (§4.4). Shared with #48, which needs the same
   `orgId ↔ tenantId` row — so these two are done adjacently, not in sequence.
5. ~~**The connector seam (§4.2) + the invites engine (#35, engine half)**~~ — built.
   The executor drains the outbox inline after commit and stamps `causedBy` on the admin
   rows it writes; the invites engine emits and never touches the directory itself.
6. **The tenant-admin surface (#35, app half; #33).** Its own app, its own auth — the
   authhero path, self-service, org membership. Not bolted into the staff console: §6's
   two-regimes point means that would be a category error.
7. **The admin vertical itself** — the platform tenant composing the same engines. This is
   where dogfooding is actually collected.

Deferred: metering and billing (#38, #39) per §7. Opportunistic: per-person staff actors
(#42) — a real bug, five operators, nothing blocks on it.

## 9. Consequences and risks

- **This converts a bounded queue into a platform program.** Five issues that could be
  closed one at a time become one sequenced body of work with a kernel change at its root.
  That is the honest cost, and it is how schedules disappear. The discipline that keeps it
  bounded is the two-consumers test applied per engine, per §1 — membership passes today,
  metering does not, and nothing else gets grandfathered in on elegance.
- **The bootstrap chicken-and-egg is real but small.** Who provisions the platform tenant's
  scope? An out-of-band seed. §3 already named this and correctly called it trivial.
- **Provisioning becomes async, and suspend-for-incident is the sharp case.** §3's warning
  stands: async suspend is worse than a synchronous call when it is being used as an
  incident weapon. The executor pattern is compatible with §3.3's idempotent-and-journaled
  requirement, but the incident path may want to stay synchronous host code even after the
  rest moves.
- **The audit trail splits** across the vertical's outbox and the executor's log, and needs
  correlation. §3 flagged this; it is the main thing that gets worse before it gets better.
- **`boundary-lint` is unchanged.** The admin vertical is module code and is bound by every
  module rule — including that it never touches `_substrat_*` tables. The §4 seam is what
  makes that possible rather than a thing to be worked around.
- **The identity model still cannot represent a person in two tenants.**
  `_substrat_identities` is keyed `(provider, external_id)` → one principal, one home
  tenant ([adapter-sqlite/src/index.ts:266](../../packages/adapter-sqlite/src/index.ts#L266)).
  A consultant serving two customers has no representation. §4's seam does not fix this;
  the cross-tenant user is a distinct piece of #34 and follows
  [kernel-design](kernel-design.md) §4.3's three-audiences model (staff org on a central
  pool, consumers in per-tenant pools).
- **Staff signup is currently open.** `emailAndPassword` is enabled with no `disableSignUp`
  ([staff-auth.ts:31](../../apps/control-plane/src/staff-auth.ts#L31)), leaving the
  allowlist as the only gate in front of a surface that can suspend every tenant. Unrelated
  to this decision, filed separately, and should not ride along on it.
