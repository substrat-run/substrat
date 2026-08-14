---
'@substrat-run/builder': patch
---

The studio records its token spend (#646): the builder worker gains its own
CP-less kernel scope — a `ScopeDO` bundling only the metering engine,
provisioned via `provisionScopeLocal` under a fixed studio node — and the
turn loop reports each turn's `usage` event into it: two counter entries
(`ai.tokens.input`/`ai.tokens.output`), subject = the project ref, dedupe
key = the turn's ulid, so a replayed report can never double-bill.
Recording is best-effort by design: the turn's product is the commit, and a
metering outage logs a miss rather than failing the turn. This is the first
brick of the builder's record-keeping half becoming a vertical (D-31/D-33);
when builder teams arrive, recording moves to per-team scopes and the fixed
node retires.
