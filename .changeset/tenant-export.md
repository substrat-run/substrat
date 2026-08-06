---
"@substrat-run/control-plane-api": minor
"@substrat-run/contracts": minor
---

feat(control-plane): export a whole tenant — Art. 20 portability, and the escrow handover (#36)

`GET /tenants/:t/export` returns one tenant, whole, in one file: the tenant record, its
scopes, orgs and memberships, roles, entitlements, identity links, hostnames, the store
ledger, connections — and each scope's database.

**Composed only from the sanctioned reads** (`listScopes`, `listOrgs`, `listMembers`,
`listRoles`, `listEntitlements`, `listIdentityLinks`, `listHostnames`, the store ledgers,
`listConnections`, `exportScope`), which is a constraint rather than an implementation
note: control-plane.md §7 says the control plane must not acquire a back door into scope
databases, and an export that reached past the audited surface would *be* that back door.
Because every part is already K-24 access-logged, so is the whole. No adapter changes —
both adapters get it because they already implement the seam.

**A different shape from #40's directory dump, deliberately.** That one is raw tables for
*recovery*: complete, replayable, unreadable to a customer. This one is one tenant's slice
in the platform's own documented vocabulary, so the receiving party can read it without
knowing our schema. Only the per-scope `data` is raw, because that half has to be loadable
— and the round trip (export → `importScope` → same tables, same row counts) is a test
rather than a claim, which is #36's own acceptance criterion.

Four rules, each of them a way of not lying about what the file is:

- **Masked by default; `?full=true` is the break-glass** — the same posture as `scope
  pull`, with one heuristic sweeping *both* halves. Driving this surfaced a real gap: an
  identity link's `externalId` is usually the person's email, and the shared PII heuristic
  did not match it. `external_id` is now in the column list, which also masks opaque
  third-party ids in a masked pull — the lossy direction of a trade that costs fidelity
  nothing and a leak everything.
- **Tombstones are exported; their data is not.** An archived or reaped scope's record is
  part of the tenant's history; a reaped scope has no storage left, so nothing in `data`
  claims to be its data.
- **Stores are inventoried, not contained** — per-tenant D1/R2 stores appear as a ledger.
  Their bytes are not in the file, and an export that omitted them would read as complete.
- **The admin log is `full`-only** — it records what *staff* did, so it is not Art. 20
  material, but it is what an escrow or a dispute needs.

**Jurisdiction refuses as a unit**: one pinned scope taints the file (K-7/K-32), so the
route refuses rather than exporting the global scopes and quietly omitting the rest.

New `tenantExport` contract, composed from the existing schemas rather than restating
them. `maskRecords` joins `maskDump` so object-shaped records get the same sweep as
table-shaped ones.

Not in this change: retention. The admin log is append-only with no sweeper and the backup
buckets have no lifecycle rule — deleting from an audit log §4.4 says is kept whole is a
policy decision, tracked rather than assumed.
