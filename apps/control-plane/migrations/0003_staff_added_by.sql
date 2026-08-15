-- Roster attribution for the console's Members surface.
--
-- Staff grants now happen from the console (Members view, /api/members*), not
-- just wrangler, so the roster gains attribution: who added this staff member.
-- Nullable — every pre-existing row (and a wrangler bootstrap INSERT) has no
-- recorded granter.
--
-- (An earlier draft of this migration also created a `builder_access` email
-- allowlist for the builder studio. It was dropped before ever shipping:
-- studio access is the `builder` ENTITLEMENT on the tenant — granted in the
-- console like any SKU, checked by the studio via the identity-tenants lookup
-- — so access follows the team, not a platform-side email list.)

ALTER TABLE staff_actor ADD COLUMN added_by TEXT;
