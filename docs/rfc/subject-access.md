---
status: proposed
layer: plan
description: Art. 15 subject access, the half the platform has not built. Reads what erasure already reaches, through one shared plan, so the two cannot drift. A team's owner or admin runs it from the dashboard's Data tab, every request lands in the admin log under their name, it is exempt from the residency gate the bulk exports carry, and it ships without the recipients section until the disclosure register's P1 lands. D-74 proposed.
---

# RFC: subject access — what the platform holds about one person (GDPR Art. 15)

**Status: proposed. Nothing here is agreed.** [D-74](../decisions/D-074-a-subject-access-export-reads-what-erasure-reaches-from-the-dashboard-data-tab-audited-and-outside-the-residency-gate.md)
records the recommendation as proposed. A human ratifies by rewriting this into `architecture/`
and accepting D-74, or by closing it.

It is written against `7c6cdc1ee`. Each load-bearing claim carries a file and a line on that
commit.

---

## 1. What is being asked

A data subject asks a controller *what do you hold about me*. Article 15 makes the answer more
than a copy of the data:

| Art. 15 | The answer owed | Who can supply it on the hosted platform |
|---|---|---|
| (1) | whether data about the person is processed at all | the platform, from what it finds |
| (1)(a) | the purposes | the controller |
| (1)(b) | the categories of data | the platform, from the model |
| (1)(c) | the recipients | the platform, once the disclosure register exists (§3.5) |
| (1)(d) | the retention period | partly the platform (declared windows), the rest the controller |
| (1)(e)–(f) | the rights to rectify, erase, object, and to complain | the controller (text, not data) |
| (1)(g) | the source, where not collected from the person | the platform, from each event's operation and actor |
| (1)(h) | automated decision-making | the controller |
| (3) | a copy of the data, in a commonly used electronic form | the platform |
| (4) | the copy must not adversely affect the rights of others | both: the platform masks, the controller reviews |

The shared-responsibility line already drawn in
[hosting-and-certification.md](../strategy/hosting-and-certification.md) holds here unchanged:
*"DSAR fulfilment (we provide extraction, they define scope)"*. This RFC is about the
extraction. The controller still writes the answer and sends it.

[why-substrat.md](../strategy/why-substrat.md) names the gap in its own table: *"Art. 17 erasure
is shipped with a receipt; the Art. 15 export that answers 'what do you hold about me' is not …
we do the cryptographically hard part and not the part a customer actually asks for first"*.
[master-plan.md](../master-plan.md)'s build list has carried "DSAR export" beside erasure since
the plan was written. No issue tracks it.

## 2. What already exists

**Erasure already answers "where is this person".** To erase someone, `shredSubject` has to find
them, and since K-37 and K-46 it finds them in these places:

- **The event log.** `_substrat_outbox` rows with `subject_id = ? AND pii_class != 'none'`
  (`packages/adapter-sqlite/src/index.ts:12628`, `packages/adapter-cloudflare/src/scope-do.ts:9376`).
- **The spine's other copies of an event.** Platform intents that embed a classified event, and
  job runs started with a declared `subject` (`packages/kernel/src/subject-redaction.ts`,
  `packages/kernel/src/job-run.ts:449`).
- **A module's own tables, by declaration.** An entity that declares
  `erasure: { subjects: [...] }` beside its `erasable` list. A row is the subject's when any
  subject column equals the id (`packages/kernel/src/module-erasure.ts:400`–`:410`).
- **A module's own tables, by hook.** `onSubjectErased` for an entity declared
  `erasure: { mode: 'custom' }`, held to the module's own tables by
  `assertWithinErasureReach` (`module-erasure.ts:202`).
- **Bindings.** Every record bound to the subject, or that is the subject, captured before the
  erasure writes (`captureBoundOf`, `packages/kernel/src/entity-binding.ts:322`).
- **Platform stores**, through the reserved `substrat.erase` operation
  (`packages/contracts/src/scope-store-envelope.ts:55`). A driver that cannot erase yet is
  refused before anything is erased (`packages/control-plane-api/src/api.ts:7425`–`:7436`).

It also says, on every receipt, what it did **not** reach: `unreachedEntities` names each entity
holding `erasable` fields that neither declares subject columns nor is claimed by a hook
(`packages/contracts/src/control-plane.ts:362`). [kernel-design.md §13.1](../architecture/kernel-design.md)
publishes the rest as numbered limits.

**Two exports exist, and neither is an access request.** The governed scope pull
(`api.ts:8029`) and the tenant export (`api.ts:8094`, #36, labelled "GDPR Art. 20
portability") both hand out whole databases. The scope pull is on the tenant credential's
allowlist (`api.ts:1815`), so a team reaches it from the dashboard's Data › Export & import
(`apps/dashboard/src/authority.ts:2148`). The tenant export is staff-only. Both are K-24
access-logged, masked by default with a shared pseudonymizer
(`packages/control-plane-api/src/pseudonymize.ts`, #1034), and refused for any scope pinned to a
jurisdiction other than `global` (`api.ts:8038`, `:8110`). Filtering one of them down to a person
after the fact would mean pulling every person to find one.

**The dashboard already has everything a door needs** ([architecture/dashboard.md](../architecture/dashboard.md)
§4). A dashboard operation checks a `dashboard:*` key in the team's own scope. The plane is called
with a tenant token whose route allowlist is default-deny (`TENANT_ROUTES`, `api.ts:1742`), and
every admin row it writes records the signed-in member as `onBehalfOf` beside the service that
executed (#977). The team's Audit › Activity page shows that row under the member's name, with the
staff impersonation stamp when there is one (`apps/dashboard/web/src/views/Audit.tsx:490`–`:491`).
Restore is the precedent for a sensitive data action there: it sits in the Data tab behind
`dashboard:restore-app-data`, which `owner` and `admin` hold (`apps/dashboard/PERMISSIONS.md`).

**The disclosure register is designed and unbuilt.** [rfc/disclosure-register.md](disclosure-register.md)
§8.3 recommends a derived read of connector deliveries about a subject, and §8.9 lists it as P1
(`listSubjectDisclosures`). Nothing in `packages/` or `apps/` implements it on this commit.

## 3. The design

### 3.1 One reach, read two ways

**Access reads exactly what erasure writes, through the same plan.** `moduleErasurePlan`
(`module-erasure.ts:128`) already turns each module's declaration into per-entity tables, subject
columns, fields and modes. The subject-match predicate it builds inline
(`module-erasure.ts:408`–`:410`) moves into one exported function. Erasure and access both call
it. A new subject column then reaches both, and nobody can add one to erasure and forget access.

The kernel gains one read, `readSubject`, on both adapters. It takes the subject id and a cursor
and returns one page per source, in one read transaction so the page is consistent. It writes
nothing, and it uses no hook that can write.

**The event read is deliberately wider than the erasure predicate.** Erasure redacts
`pii_class != 'none'`, because it judges a payload as personal data or not. Access answers
*whether data about the person is processed at all*, so it returns every outbox row with
`subject_id = ?`, including `piiClass: 'none'` events. A row whose payload an erasure already
nulled is returned as its envelope, with `payload: null` and `erased: true`, which is what the
person is owed: the fact that something happened, recorded without its content.

**Parity is a contract test, on both adapters.** For a subject never erased, run `readSubject`
then `shredSubject` on the same scope and assert:

- the events with `piiClass != 'none'` and a payload equal `eventsRedacted`;
- per declared `blank` or `delete` entity, the rows holding a value in any erasable field equal
  that entity's `verticalRows` line;
- `unreachedEntities` is the same list on both.

That test is what turns "everything erasure reaches, access reads" from a claim into a gate.

### 3.2 Where each part comes from

| Source | Erasure today | Access |
|---|---|---|
| `_substrat_outbox` | nulls classified payloads, keeps the envelope | every row with the subject's id, decoded like `readHistory` (`packages/kernel/src/timeline.ts:278`): type, time, operation, actor, `piiClass`, payload |
| Declared entities (`blank`, `delete`) | blanks or deletes matching rows | `SELECT` of the matching rows, whole, through the shared predicate |
| `custom` entities | `onSubjectErased` | a read-only twin, `onSubjectAccess(ctx, { subjectId })`, held to the same allowlist with `select` as the only verb. Synchronous, returns `{ entityType, row }[]` |
| Bindings | released after the module half | the records bound to the subject, read with `captureBoundOf` |
| Platform intents, job runs | redacted where they embed a classified event or declare the subject | read, by the same walk |
| Platform stores | `substrat.erase` | a new reserved operation, `substrat.access`. A driver registration gains `access: 'pending'` as it has `erasure: 'pending'` (`packages/contracts/src/deploy.ts:429`). A scope with a store whose driver cannot answer is **refused, 501**, not answered without it |
| Backups, stored dumps, the lake | crypto-shredded, or not reached (limit 6) | not read: they are copies of the rows above. Listed in the package as storage locations with their retention windows |

**A `custom` entity with no access hook is unreached for access.** It is not refused at
registration: refusing would break every deployed module that has `onSubjectErased` today, and
D-28 makes the module contract additive. `lint:model` warns on it, as it warns on an entity with no
erasure.

**A store is refused rather than skipped** for the reason the tenant export refuses a pinned
scope instead of omitting it (`api.ts:8105`–`:8109`): an incomplete answer that does not say it is
incomplete is the failure worth avoiding. The refusal names the binding and the driver.

### 3.3 The package

The route returns one JSON document, `substrat.subject-access/v1`:

```jsonc
{
  "kind": "substrat.subject-access/v1",
  "subjectId": "01J…",                       // the pseudonymous id the request names
  "tenantId": "…", "scopeId": "…",
  "jurisdiction": "global",
  "vertical": { "slug": "…", "version": "…" },
  "generatedAt": "2026-11-20T10:00:00.000Z",
  "events":   [{ "id": "…", "type": "…", "occurredAt": "…", "operation": "…",
                 "actor": { "kind": "person", "ref": "p_7f3a…" },   // pseudonymized unless it is the subject
                 "piiClass": "direct", "payload": { … }, "erased": false }],
  "records":  [{ "module": "…", "entityType": "…", "mode": "blank",
                 "rows": [{ … }], "maskedColumns": ["assignee_id"] }],
  "bindings": [{ "entityType": "…", "entityId": "…" }],
  "intents":  [ … ], "jobRuns": [ … ], "stores": [{ "binding": "…", "rows": [ … ] }],
  "categories": [{ "entityType": "…", "fields": ["email", "phone"] }, { "events": ["direct", "pseudonymous"] }],
  "storage":  [{ "copy": "backup", "retention": "…" }, { "copy": "lake", "retention": "…" }],
  "recipients": { "status": "not-available", "reason": "the disclosure register is not built" },
  "unreached": { "entities": [{ "module": "…", "entityType": "…" }],
                 "limits": ["attachments", "free-text", "unclassified-events", "request-logs"] }
}
```

- **`records` are whole rows**, not only the erasable fields. A copy of the data is more useful,
  and more honest, with the row around it: the status of the ticket, the date of the booking.
- **`categories`** is derived, not written: the `erasable` fields of each entity that returned
  rows, and the `piiClass` values of the events returned (`packages/contracts/src/events.ts:30`).
- **`storage`** lists where copies live and for how long, from the platform's declared windows.
  It is half of (1)(d). The other half, how long the controller keeps the live data, is theirs.
- **`unreached`** carries the same list a shred receipt does, plus the fixed limits of §5, so the
  controller reads the gaps in the package and not in a later complaint.

The same document renders as one self-contained HTML page for the person, the way `model-view`
renders a `model.json` (`packages/model-view`). It uses the entity and field names the model
declares, because the model declares no display labels. Translating those names for a reader is
the controller's.

### 3.4 Other people in the subject's rows (Art. 15(4))

A row that is the subject's can name someone else: the staff member assigned to their ticket, a
second customer on a shared booking.

- **Other subject columns are pseudonymized.** A matched row's subject columns that hold a
  different id are replaced by the package's pseudonymizer, the one the masked exports use, with
  a fresh salt per package, so the same colleague reads the same token across rows and events.
  `maskedColumns` names them.
- **Actors are pseudonymized unless they are the subject.** An event's authorization chain names
  the principals who acted. The person is owed what was done and when, not which employee did
  it. The CJEU read Art. 15 that way for consultations in C-579/21 (2023). The kind of actor
  stays visible: a person, the system, a connector.
- **Erasable fields on a matched row are returned as the subject's.** Erasure blanks them all
  when any subject column matches, so access treats them the same way. A model that puts two
  people's erasable data on one row discloses it to both. The fix is in the model (split the
  row), and §5 says so.
- **Event payloads are returned as recorded.** An event is keyed to one subject (limit 1), and
  its payload has no per-field owner the kernel can read.

**The controller reviews before anything reaches the person.** The package is downloaded by the
controller's own owner or admin (§3.5), never sent straight to the subject. That review is the real
Art. 15(4) safeguard. The masking keeps the obvious cases from depending on it.

### 3.5 The door: the dashboard's Data tab

```
POST /tenants/:tenantId/scopes/:scopeId/subjects/:subjectId/access
  { reference: string, requesterVerified: true }
→ 200 { package, receipt }
```

**A team's owner or admin runs it from the dashboard, in v1, recommended.** The controller is the
one who answers the person, so the package goes straight to them. A staff relay would add a hop, a
delay against a one-month deadline, and a copy of the person passing through us.

**Where.** A fifth section of the app's Data tab, **Personal data**, beside Tables, Schema,
Previews and Export & import (`apps/dashboard/web/src/views/AppDetail.tsx:3093`). It is a section
of an existing tab, not a new tab. The form takes the person's id, a reference for the request,
and a confirmation that the requester's identity was checked. It downloads the JSON package and its
HTML page. Erasure can later join the same section, so one request reads as one place.

**Who: a new key, `dashboard:subject-access`**, "Download everything an app holds about one person,
to answer their access request". `owner` and `admin` hold it, as they hold
`dashboard:restore-app-data`; `member` and `viewer` do not. A check-only dashboard operation,
`dashboard/authorize-subject-access`, asks it before the plane is called, the way
`dashboard/authorize-restore` does (`apps/dashboard/src/module.ts:813`, bound at `:2266`).
Adding the key changes `apps/dashboard/PERMISSIONS.md`, so the PR that adds it carries the
permission-diff checkpoint (CLAUDE.md).

**Reach: the tenant token.** The route joins `TENANT_ROUTES` with `pin: 'path'`, and the dashboard
reaches it through `TenantNarrowedControlPlane`, so its `credential-reach` test holds the two
together. It stays out of `BUILDER_ROUTES` (`api.ts:2394`): the CLI has no reason to pull a person.
Staff keep the same route for a request a customer forwards to us.

**What the door gathers is not new reach.** An owner or admin can already read every row of the
app in Data › Tables. What is new is that one person's rows, unmasked, are put into one file. The
dashboard's own export is masked and calls full fidelity "a CLI/staff affordance"
(`AppDetail.tsx:2134`). This door makes a full-fidelity copy of one person a team affordance, and
this RFC asks for that on purpose. It is bounded by:

- **one person per call**, named by id;
- **a key only owners and admins hold**, checked in the team's own scope;
- **a recorded reference and identity confirmation** on every call (Art. 12(6) leaves the check to
  the controller, and the form makes them say they did it);
- **an admin-log row under the member's name** that every team member who can read Audit sees (§3.8).

D-45 kept erasure staff-only because it destroys evidence. Access destroys nothing, so the same
argument does not carry over. Erasure keeps its own decision.

**`POST`, not `GET`.** The call writes two audit entries and a receipt. It is neither cached nor
safe to prefetch.

**Which copy is read.** The serving deployment's, resolved as `…/shred` resolves it
(`resolveVerticalRef`). Script copies are copies of the same scope. Erasure must reach all of them,
and access has to read only one. A scope with a copy move in flight is read from the serving side,
since nothing is destroyed if a copy differs.

### 3.6 Residency: the package is exempt from the jurisdiction gate

Every route that hands out scope bytes refuses a scope pinned tighter than `global`
(`api.ts:7231`, `:8038`, `:8110`, `:8782`), on K-32's grounds: the bytes *"land on a machine
outside the platform's control"* and *"move that data out of the region it was promised"*. **This
route does not, recommended.**

- **The law requires the package to leave.** Art. 15(3) obliges the controller to hand the person
  a copy, within one month (Art. 12(3)). A residency gate on this route would make the platform
  the reason a controller misses a statutory deadline on data it controls.
- **Residency is the platform's promise to the controller**, about where the platform processes
  the controller's data. It does not limit where the controller sends its own data, and the
  controller asked for this package.
- **A disclosure to the data subject is not a Chapter V transfer**, on our reading of the EDPB's
  Guidelines 05/2021: a transfer needs an importer that is a controller or a processor, and the
  person the data is about is neither. That reading is stated here, not assumed. §6 asks for it
  to be confirmed before an `eu` scope exists.
- **The exemption is narrow.** It covers this route alone, one subject per call, never `full`
  scope data. The receipt records the scope's `jurisdiction` and `residencyExempt: true`, so each
  use is visible in the admin log. The bulk exports keep their gate.

**It changes nothing in production today.** `provisionableJurisdiction` admits `global` only
(`packages/contracts/src/tenancy.ts:189`), so no hosted scope is pinned. Deciding now means the
work that makes `eu` real (K-32) inherits the exemption instead of accidentally blocking every DSAR
in the region that asks for them most.

### 3.7 Recipients: not in v1

Art. 15(1)(c) wants the recipients. The platform's answer is the disclosure register's derived
read, and it does not exist. **v1 ships without it, recommended**, and says so in the package:
`recipients: { status: 'not-available', reason }`. It is an explicit absence, never `[]`, because
an empty list would assert that nobody received anything.

Until P1 of [rfc/disclosure-register.md](disclosure-register.md) §8.9 lands, the controller
answers (1)(c) from its own records. When it lands, the section is filled from
`listSubjectDisclosures`, worded as that RFC's F2 requires ("connector deliveries about a subject",
never "what the processor holds"), with P2's declared `discloses` superset beside each provider
once that exists.

Waiting for P1 would hold the most-asked half of a DSAR behind the least-built half. The section
is additive to the package, so shipping it later changes no consumer.

### 3.8 The receipt, the audit, and size

**Every request is recorded, under the name of the person who made it.** The call writes to both
logs, like shred:

- **The admin log** records `subjectAccess`, with the receipt as `after`. Through the dashboard,
  the row keeps `actor` (the service that executed) and carries `onBehalfOf`: the signed-in
  member, their tenant, and the staff impersonation stamp when staff acted as them (#977, K-42).
  The member comes from the signed tenant token, never from a header or the body, so the name on
  the row is not one the caller chose. The admin log is the compliance witness and is never swept
  (kernel-design §13.1, limit 5).
- **The K-24 access log** records the read, as it does for every route that hands out scope data.

**The team sees it.** Audit › Activity reads the admin log for the tenant (`/admin-log`, pinned
by query, `api.ts:1870`) and shows the row as the member, "via Dashboard"
(`apps/dashboard/web/src/views/Audit.tsx:490`–`:491`). Its sentence is written for the action:
"<member> downloaded personal data about one person from <app>", not the generic "admin action: …"
`actionWords` falls back to (`apps/dashboard/web/src/lib/audit-activity.ts:47`). Any member who
can open Audit sees it, so a pull by one admin is visible to the others. A request staff run for a
customer is recorded against the same tenant, with staff as the actor, so it shows there too.

**The receipt holds counts, a reference and the confirmation, never content**, for the reason the
shred receipt does (`control-plane.ts:355`–`:361`): an admin log that kept a copy of what a person
was sent would be a second copy of that person. For the same reason the form asks for a
*reference* (a ticket number, the date of the request) and says not to type the person's name:
the row it lands in is never swept.

```jsonc
{ "subjectId": "01J…", "generatedAt": "…", "reference": "DSAR-2026-014", "requesterVerified": true,
  "jurisdiction": "global", "residencyExempt": false,
  "events": 41, "erasedEvents": 0, "records": [{ "module": "…", "entityType": "…", "rows": 3 }],
  "intents": 0, "jobRuns": 1, "stores": [], "unreachedEntities": [ … ], "recipients": "not-available" }
```

The receipt is what lets a controller prove it answered, when, and who on their team did it.

**No index serves the read today.** Neither adapter indexes `_substrat_outbox.subject_id`
(`index.ts:1466`–`:1475`, `scope-do.ts:773`–`:782`), so erasure's own redaction scans the outbox.
P1 adds `CREATE INDEX _substrat_outbox_subject ON _substrat_outbox (subject_id, id) WHERE
subject_id IS NOT NULL` to both spines. It is partial, so the many events with no subject pay
nothing, and `lint:spine-ddl` holds the two sides equal. Erasure gets faster too.

**Pages, assembled by the control plane.** `readSubject` takes a cursor per source, as
`readScopeHistory` does (`timeline.ts:468`). The route walks the pages and returns one document.
If a real subject outgrows one response, a later phase writes the package to an object and returns
a link. Nothing in v1 depends on that.

## 4. Alternatives considered

- **Filter the masked scope export by subject.** It pulls every person to find one, and masking
  is the opposite of what an access request needs for the subject's own fields. Rejected.
- **Search every table for the id.** It finds the id in columns nobody declared as a subject link,
  and misses rows linked in ways only a hook knows. It also disagrees with erasure by construction.
  Rejected: the declared reach is the one place where "this is the person's" is stated.
- **Staff-only in v1, the way erasure is.** A builder forwards the request, staff run it, and the
  package goes back. It keeps a human between the request and the bytes, but it adds a hop
  against a one-month deadline and passes a copy of the person through us, and the dashboard
  already holds the permission, reach and attribution a team door needs (§2). Not taken: staff
  keep the route for forwarded requests, and the team runs its own.
- **The door in Data › Export & import.** That section is the whole-app masked export and restore.
  A person's request is a different act with a different audience, and erasure can later join a
  section of its own. Not taken.
- **A new key for every member.** `member` can provision apps, but a person's whole record is a
  narrower trust than running the app. Not taken: `owner` and `admin` only, as for restore.
- **Keep the residency gate, and add an `eu` path later.** It would block the requests from the
  region that makes the most of them, for a promise that does not cover this case (§3.6).
- **Wait for the disclosure register.** Argued against in §3.7.

## 5. Limits, stated

These ship as documentation beside the feature, the way erasure's limits do (D-45). Most are
erasure's limits read from the other side.

1. **An entity with no subject link is not read.** The same entities erasure does not reach. On
   this commit that is every in-repo model except ticket0, including the engines' hand-written
   manifests (kernel-design §13.1, limit 2). Adoption of `erasure: { subjects }` brings a model
   inside both guarantees at once.
2. **One id, one scope per call.** A person known by a contact id and a principal id is two calls.
   A tenant with many apps is one call per app. The fan-out is phase 5.
3. **Free text that names a person without their id is not found** (limit 9).
4. **Attachments are not read.** They carry no subject (`packages/kernel/src/attachment-text.ts:73`).
5. **Events emitted without a `subjectId` are not found.**
6. **Platform request logs and analytics are not read.** They hold principals, not subjects, and
   live outside the scope.
7. **Copies are listed, not read.** A backup, a stored dump or the lake holds what the live rows
   held, or less. The package names them and their windows.
8. **Two people's erasable data on one row is disclosed to both** (§3.4).
9. **The answer is the controller's.** The package is the extraction. Purposes, lawful basis,
   retention of live data, automated decision-making and the review of other people's data are
   theirs (§1).

## 6. Open questions for the human

1. **Ratify the three recommendations**: the dashboard door for owners and admins, recorded under
   the member's name (§3.5, §3.8), the residency exemption (§3.6), v1 without recipients (§3.7).
2. **The permission diff** when P2 lands: `dashboard:subject-access`, held by `owner` and `admin`.
3. **Confirm §3.6's Chapter V reading with counsel** before the first `eu` scope is provisionable.
   If it does not hold, the exemption narrows to delivery through the controller inside the region.
4. **Is `readSubject` a kernel read or a `HostAdmin` method?** This RFC places the read in the
   kernel, the route in the control plane, and the audit on `HostAdmin`, as `shredSubject` does.

## 7. Phased plan

Each phase is its own PR, and each is useful if the next never ships.

- **P1 — the read.** `readSubject` on both adapters over the outbox and the declared entities, the
  shared match predicate, the partial `subject_id` index, and the parity contract test against
  `shredSubject`.
- **P2 — the route and the door.** The route with its receipt and both audit entries, on
  `TENANT_ROUTES` and for staff; the residency exemption; `recipients: not-available`; the HTML
  render. In the dashboard: `dashboard:subject-access` for `owner` and `admin` (the
  `PERMISSIONS.md` diff), `dashboard/authorize-subject-access`, the Data › Personal data section,
  and the Activity sentence for `subjectAccess`.
- **P3 — the rest of the reach.** `onSubjectAccess`, bindings, intents and job runs, and
  `substrat.access` with `access: 'pending'` on driver registrations.
- **P4 — recipients**, once the disclosure register's P1 lands.
- **P5 — across apps.** One request fanned out over every app in the team, recorded as one row per
  app. Erasure wants the same fan-out.
