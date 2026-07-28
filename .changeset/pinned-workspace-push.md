---
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

The workspace pin travels with a push and is honored, never silently reinterpreted. The
CLI sends the project's pinned workspace (`substrat.tenant`) as a form field alongside
the bundle; the deploy route resolves who the push is FOR before anything reaches the
namespace. For a builder the pin must match the authenticated workspace — a mismatch is
a 403 naming both sides, instead of a push that lands somewhere the project didn't say.
For staff the pin is what was previously dropped on the floor: a pinned staff push now
claims `<tenantSlug>/<slug>` owned by that tenant — prefixed, dashboard-visible, and
self-admitting, exactly as the equivalent builder push — closing the dual-hat footgun
where a staff-roster account (which can never authenticate as a builder, staff being the
superset tried first) pushed verticals its own workspace could neither see nor
self-serve. A bare slug already owned by the pinned tenant stays addressable as itself;
unpinned staff pushes keep the platform-owned behavior; old CLIs that send no pin are
unaffected on every path. `effectiveSlug` is now idempotent so a builder may address its
own vertical by the full registry id a deploy response returns, and the CLI's same-run
`--promote` uses exactly that id (with the version bump computed across both the
prefixed and legacy-bare lineages).
