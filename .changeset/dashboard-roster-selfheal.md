---
'@substrat-run/dashboard': patch
---

Self-heal pre-roster teams: teams provisioned before #191 have an empty
`dashboard_members` table (no owner row), so every roster-gated move — delete
the organization, the Members tab, invites — refused its own owner with a 403.
`resolveAccount` now seeds the resolving caller as the owner row (plus the
invites entitlement and org) for pre-epoch tenants, gated by ULID timestamp and
memoized per isolate so post-fix teams never pay a read.
