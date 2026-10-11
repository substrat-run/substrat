---
'@substrat-run/builder': minor
'@substrat-run/builder-workspace': minor
---

The builder can run a build turn as two lanes, the API and then the UI, with write guards that do not overlap (#682). This is opt-in: start the local studio with `--lanes` (or `SUBSTRAT_BUILDER_LANES=1`), or run `pnpm builder evals --lanes`. Without the flag, nothing changes.

- The API lane may write everything except `app/**`, under the usual build guard. The UI lane may write only `app/**`. Its context is the concept's screens section and `spec/model.ts`, its history is only its own passes from this turn, and its prompt carries two skills: `ui.md` (the `app/` rules) and `ui-lane.md` (what being a lane means). The gates run once, after both lanes. Gate repairs run without lanes, as before. A concept with no screens to build runs unlaned.
- When the UI lane needs an operation the API does not offer, it writes the gap to `app/CONTRACT-GAPS.md` instead of crossing its guard. The next turn's API lane reads the gaps, capped at 20 entries and deduplicated.
- A red gate report carried into the next turn reaches each lane, split by which lane owns the paths it names: an `app/` type error goes to the UI lane, which can fix it.
- `runTurnLoop` accepts an optional `lanes` list and an optional `carriedFor` router. Each pass, continuations included, is told which lane it belongs to.
- Write guards now resolve `.` and `..` before they judge a path, and refuse a path that resolves above the project. Their refusals fold case, so on a case-insensitive filesystem `Spec/model.ts` and `src/../spec/model.ts` no longer get past the build guard.
- `scaffold.md`'s closing `app/` paragraph is now its own file, `ui.md`, split out verbatim and loaded right after `scaffold.md`. An unlaned scaffold reads the same rules in the same order as before. The lane-only instructions live in `ui-lane.md`, which only the UI lane loads.
- Eval results record `laned`, so laned and unlaned runs are never compared by mistake. Whether lanes save tokens is still unmeasured: that is #630's sweep to decide.
