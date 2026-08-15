-- Builder-studio access grants + roster attribution (console Members surface).
--
-- The hosted builder studio (apps/builder) was gated on `staff_actor` alone — the
-- same roster that authorizes CONTROL-PLANE access. Granting an external user the
-- studio therefore meant granting them platform-staff powers, which is exactly the
-- coupling this table breaks: `builder_access` names who may use the studio and
-- NOTHING else. Staff keep implicit studio access (the builder checks both tables);
-- a row here never grants any control-plane capability. The eventual replacement is
-- the plan-entitlement flag (builder-plane.md §7); until then this is the deliberate,
-- revocable interim.
--
-- Same shape and semantics as staff_actor: email is the key (lowercased at the
-- boundary), revocation TOMBSTONES rather than deletes (K-21) — a row that once
-- granted access is the evidence of why an act was permitted. No actor column:
-- builder users never act on the control plane, so there is nothing for the admin
-- log to name. `added_by` names the staff member who granted it.

CREATE TABLE IF NOT EXISTS builder_access (
  email      TEXT PRIMARY KEY,  -- lowercased at the boundary
  name       TEXT,
  added_by   TEXT NOT NULL,     -- PlatformActorId of the granting staff member
  added_at   TEXT NOT NULL,
  revoked_at TEXT               -- non-null = access withdrawn, row kept as evidence
);

-- Grants now happen from the console (Members view), not just wrangler, so the
-- roster itself gains the same attribution: who added this staff member. Nullable —
-- every pre-existing row (and a wrangler INSERT) has no recorded granter.
ALTER TABLE staff_actor ADD COLUMN added_by TEXT;
