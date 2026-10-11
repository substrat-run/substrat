---
'@substrat-run/builder': minor
'@substrat-run/builder-workspace': minor
---

The builder can run a build turn as two lanes, the API and then the UI, with write guards that do not overlap (#682). This is opt-in: start the local studio with `--lanes` (or `SUBSTRAT_BUILDER_LANES=1`), or run `pnpm builder evals --lanes`. Without the flag, nothing changes.

- The API lane may write everything except `app/**`, under the usual build guard. The UI lane may write only `app/**`. Its context is the concept's screens section and `spec/model.ts`, and its prompt carries one skill, `ui.md`. The gates run once, after both lanes. Gate repairs run without lanes, as before.
- When the UI lane needs an operation the API does not offer, it writes the gap to `app/CONTRACT-GAPS.md` instead of crossing its guard. The next turn's API lane reads the gaps, capped at 20 entries and deduplicated.
- `runTurnLoop` accepts an optional `lanes` list. Each pass, continuations included, is told which lane it belongs to.
- Write guards now resolve `.` and `..` before they judge a path, so `src/../spec/model.ts` no longer gets past the build guard.
- The `app/` rules moved out of `scaffold.md` into `ui.md`, which an unlaned scaffold turn still loads.
- Eval results record `laned`, so laned and unlaned runs are never compared by mistake. Whether lanes save tokens is still unmeasured: that is #630's sweep to decide.
