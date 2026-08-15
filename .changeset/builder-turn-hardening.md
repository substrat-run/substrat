---
"@substrat-run/builder": patch
"@substrat-run/builder-workspace": minor
"@substrat-run/builder-generator": minor
---

Builder turn hardening — four fixes from the first hosted FamilyFlow run.

**Gate feedback reaches the hosted agent (H5 port).** The `BuilderAgent` DO now
does what the local server and dev CLI already did: a red run's `gateReport`
persists in project state and rides into the next turn's context, and every red
turn drives the capped in-turn repair loop. Previously the hosted model never
saw a failing gate's output — not even when the builder asked about it.

**`pnpm install` is a host responsibility.** `runTurn` installs mechanically
(new `runInstall`, reported as an `install` gate result) when the turn touched
a package.json or the vertical has one with no `node_modules` — a fresh
project under `.builder/projects/*` postdates the image's warm install, and
leaving the install to the model by prompt lost to the step ceiling, after
which every gate failed with phantom module-not-found errors. A failed install
reaches the model as pnpm's own output, not as type errors.

**Step-ceiling cuts are said out loud.** A clean stream end whose final step
still wanted tools means `stopWhen` truncated the turn: the generator now emits
a `truncated` event, and all three hosts spell it into durable history via the
shared `historyMarker` helper — a cut-off turn no longer reads as a finished
one to the UI or to the model's own next turn.

**`ask_user` discipline is enforced, not prompted.** The tool now refuses
duplicate questions (normalized text or tab header already asked this turn) and
the fifth question of a turn, with an actionable refusal. Questions asked also
persist into durable history as `[asked …]` markers, so later turns stop
re-asking what the builder already answered. (Observed: a fast interview model
asking 11 questions in one turn, three of them duplicates.)
