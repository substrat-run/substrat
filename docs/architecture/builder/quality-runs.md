---
status: building
layer: plan
description: What 50 graded todo builds taught us, and what to try next.
---

# Builder quality runs

**Status:** the first round is finished and its changes shipped, all on evidence but one: the "grant cannot be listed" rule is unproven. The strategies not yet tried
are listed in [§6](#6-what-to-try-next). · **Depends on:** [studio.md](./studio.md) §9.6, the evals
this builds on. · **Touches:** `apps/builder/skills`, `apps/builder/src/reference.ts`,
`packages/builder-workspace/src/gates.ts`, `packages/portal-starter`.

**The question:** can the builder take a one-line brief for a todo app and produce a correct app
every time, as fast and as cheaply as possible? We ran 50 graded builds in November 2026 to find
out, on Haiku and Sonnet, changing one thing per arm.

**The answer:** on Sonnet the todo app now scores 89 of 100 on six runs out of six, with no repairs
and no red gates. The baseline scored 79 to 84 with a repair in every run. Time and tokens improved
less reliably: see [§2](#2-results). The last 11 points are invites and deploying, which the template
does not offer yet. Most defects were ours: stale skills and a wrong setup, rather than the model.

## 1. How a run was graded

Gates passing says little. One run passed every gate while every action in its UI answered 404. So
each run gets a score out of 19 items, reported as a percentage:

- **14 judged items.** Three separate Sonnet readings of the code against the customer's brief,
  decided by majority ([rubric](../../../apps/builder/quality/rubric-todo.md)).
- **5 counted items.** Facts read straight from the source: a permission check for every event, a
  real sign-in, invite email, a worker entry, and a UI that reaches its API. A judge passed a copy
  with its permission checks removed, so these are no longer left to a judge.

The scorer had to pass its own controls before any run counted:

| Control | Score | Shows |
|---|---|---|
| The same code, graded twice | 82, 82 | Majority grading repeats itself. Without the majority, the same code scored 71 and 82 |
| UI replaced by the unedited starter | 59 | It catches a false pass |
| Permission checks removed | 65 | It catches missing enforcement |

A run counted only if it finished, was judged, had no infrastructure error in its log, and its
transcript showed that the change under test really ran. Every arm had a written hypothesis first.
Fifty was a ceiling, and an arm stopped early once its question was answered.

## 2. Results

Averages per arm, in the order they ran. Rows are in
[`runs-2026-11.jsonl`](../../../apps/builder/quality/runs-2026-11.jsonl). "Red" counts runs that
ended without green gates. Each arm is one change on top of what had been adopted so far.

| Arm | Model | Quality | Seconds | Steps | Repairs | Input (M) | Uncached (k) | Output (k) | Red |
|---|---|---|---|---|---|---|---|---|---|
| baseline | Haiku | 79–84 (5 runs) | 443 | 48 | 1.0 | 3.15 | 223 | 89 | 0 |
| baseline | Sonnet | 79, 84, 84 | 300 | 43 | 1.0 | 2.06 | 157 | 39 | 0 |
| install gate | Haiku | 79, 79, 84 | 486 | 50 | 0.3 | 3.75 | 221 | 95 | 0 |
| real sign-in | Haiku | 0, 84, 89 | 394 | 47 | 1.3 | 2.96 | 215 | 74 | 1 |
| shares rule | Haiku | 58, 63, 84 | 410 | 46 | 0.3 | 3.29 | 207 | 82 | 1 |
| reference bundle | Haiku | 74, 79, 84 | 399 | 48 | 0.3 | 3.43 | 196 | 80 | 1 |
| API fix | Haiku | 74, 84, 84 | 405 | 46 | 0.3 | 3.28 | 211 | 83 | 0 |
| project files | Haiku | 84, 84, 89 | 396 | 46 | 0.7 | 3.15 | 205 | 80 | 0 |
| UI rules | Haiku | 0, 58, 84 | 323 | 36 | 1.0 | 1.97 | 185 | 63 | 1 |
| adopted so far | Sonnet | 84, 84, 84 | 276 | 35 | 0 | 1.76 | 154 | 39 | 0 |
| `loaded()` helper | Sonnet | 84, 89, 89 | 293 | 38 | 0.7 | 1.84 | 164 | 41 | 0 |
| adopted so far | Haiku | 79, 89, 89 | 385 | 39 | 0.3 | 2.57 | 204 | 81 | 0 |
| lanes | Sonnet | 74, 84, 84 | 285 | 41 | 1.3 | 1.42 | 185 | 39 | 1 |
| low effort | Sonnet | 68–89 (6 runs) | 228 | 32 | 0.2 | 1.39 | 138 | 32 | 1 |
| final candidate | Sonnet | 89, 89, 89 | 258 | 32 | 0 | 1.53 | 156 | 37 | 0 |
| **as shipped, on current `main`** | **Sonnet** | **89, 89, 89** | **292** | **39** | **0** | **2.12** | **162** | **40** | **0** |

**Quality and repairs held from the candidate to what shipped. Time and tokens did not.** The skills
are the same in both, and the shipped runs made about as many reference calls. They took more coding
steps (22 to 29 against 18 to 21) on debugging detours, and input grows with every step. Three runs
cannot say whether that is variation or a cause we have not found. Over all six, the average is 275
seconds, 36 steps and 1.83M input, against the Sonnet baseline's 300, 43 and 2.06M.

A score of 0 is a run that stalled before building an app, and both were on Haiku. A contradiction
in the model or scenario left them waiting on a question, because the build may change neither.

Sonnet was faster and used fewer tokens than Haiku in every matching arm. It also never stalled. Cost
per run is missing: this path does not record a price.

### Per stage

One shipped run's six stages, averaged over the three. All 29 repairs in the ledger happened in
scaffolding and coding, and none in the stages before them.

| Stage | Produced | Steps | Seconds | Input (k) | Uncached (k) | Output (k) |
|---|---|---|---|---|---|---|
| Interview | 3 questions asked | 2 | 29 | 25 | 5 | 0.5 |
| Concept | 54 concept lines | 4 |  | 53 | 6 | 2.4 |
| Model | 276 model lines | 4 | 35 | 101 | 26 | 5.2 |
| Scenario | 16 scenario tests | 3 | 38 | 88 | 34 | 5.9 |
| Scaffolding | 29 references read or copied |  |  |  |  |  |
| Coding | 18 files written | 26 | 191 | 1856 | 91 | 26.2 |

Seconds exist per recorded stage, so Interview's include concept. Scaffolding and coding are one
recorded stage, and on the Claude Code path output tokens land late, on the last step of a pass, so
their usage cannot be split. `stages.py` reads this from each run's report and transcript.

## 3. What shipped

| Change | Evidence | Where |
|---|---|---|
| Install runs in a project with its own workspace file | Every baseline repair was this local eval artefact: repairs fell from 1 per run to 0 in two runs of three | `gates.ts` `runInstall` |
| Skills teach the real sign-in | The skills taught a header that no longer exists. `real_signin` went from 0 of 8 to 2 of 2 finished runs | `scaffold.md`, `iterate.md` |
| App and server agree on `POST /api/invoke` | The skills disagreed with each other, which left a dead UI in 3 of 3 runs. It reached the API in 3 of 3 after | `scaffold.md`, `iterate.md` |
| Project files come from the template reference | Highest quality of any Haiku arm, with no version lookups | `reference.ts`, `create-substrat/project-files.js` |
| `loaded()` in the app starter | `ui_errors` went from 0 of 3 to 2 of 3, where a written rule changed nothing | `portal-starter/src/api.ts` |
| An `app-api` gate | The dead UI was invisible to every other gate, because both halves compile alone | `gates.ts` |
| A "grant cannot be listed" rule | **Unproven.** No run stranded on it, but the arm without the rule also declared a share entity | `model.md`, `platform.md` |

## 4. What did not work

| Strategy | Result | Why rejected |
|---|---|---|
| Reference bundle: one read for many files | Reads fell about 60%, scaffold steps did not | Missed the 25% target |
| UI rules in the skill | `ui_errors` failed in every run that built an app | A written rule did not change what the model wrote |
| Lanes: API and UI in separate contexts | About 20% less input, against a 30% target | Repairs came back, `ui_reaches_api` failed in 2 of 3, one run went red |
| Low effort | About 15% faster | Last three runs scored 68, 84, 89 against 89, 89, 89. Stability matters more |

## 5. What we learned

1. **Look at our own material first.** The biggest gains came from correcting skills that had gone
   stale and contradicted each other.
2. **Code beats a rule.** The same problem resisted a skill rule and fell to a helper in the starter.
3. **Green gates say little.** A gate that can see the defect is worth more than a sentence asking
   the model to avoid it.
4. **A scorer needs controls.** Early versions passed sabotaged code and graded the same code 11
   points apart, which is wider than most of the differences in §2.
5. **Grade only what the brief asks.** Early rubric items failed runs for renaming and editing, which
   nobody had asked for.

## 6. What to try next

**Move work from the model to scripts.** The biggest lever left. In a final run of about 1,980
lines, about 240 were generated by a script:

| Source | Files | Lines |
|---|---|---|
| Generated by script | `model.json`, `PERMISSIONS.md` | ~240 |
| Copied | Project files, app shell | ~250 |
| Written by the model, derivable today | `src/migrations.ts`, manifest and provision glue, `routes.ts`, `server.ts` | ~200 |
| Written by the model, partly derivable | `src/module.ts` (10 of 13 handlers), `app/src/screens.ts`, seed, test harness | ~670 |
| Has to be written by the model | `spec/model.ts`, concept, scenario test | ~520 |

Routes, the manifest's entities and operations, and `derive` handlers already follow from the model
at run time. Two gaps need only wiring: `demos/todo` generates its migrations and its browser client
(`substrat.client`), and a generated project does neither.

In the order we would try them:

| Strategy | Why | Target |
|---|---|---|
| Generated migrations and client | The emitters exist, and hand-written SQL is the wrong kind of work for a model | No model-written SQL |
| Generate handler skeletons | Check and event stubs from the model, so `engine_rules` stops depending on memory | Output tokens down 30% |
| Generate screens | A list and detail screen per entity on `<sub-entity-table>`, so a starter cannot survive | All UI items pass |
| `check_code` tool | One call returns every compile and test failure, as `check_model` does | Fewer repairs |
| Build plan file | A checklist derived from the model survives the step limit | No missing operations |
| Fresh-context reviewer | Catches what compilers cannot | Quality up 6 points for under 15% more tokens |
| Model per phase | Interview, model and scenario are about 10% of tokens | Sonnet quality in less time |
| Pruning old tool output | 96% of scaffold input is cached already, so it may lose | Uncached tokens and time both fall |

**Decisions still open:**

- **Invites and deploying.** No run has built either, and they are the last two items. Adding a
  worker with invite routes to the template is the likely answer.
- **A way back from a contradiction.** The build cannot change the model or the scenario, which is
  what stalled the Haiku runs.
- **Blocked gates that state a remedy.** The repair loop skips them on purpose, which left two
  otherwise working runs red.

## 7. Limits

- **Three runs per arm, one fixture.** Strong signals, not guarantees. A change that wins on `todo`
  may not carry to another app.
- **An eval does not continue a cut-off turn.** The studio does, through `runTurnLoop`. No Sonnet pass
  reached the 40-step limit, so these results are unaffected, but a slower model's would be.
- **The judge reads code.** Nobody ran these apps in a browser. It keeps saying it cannot see the
  owner's `list:manage` grant, which is unchecked.
- **These ran on Claude Code's loop on a local disk.** They share prompts, tools and gates with the
  hosted path, not its agent loop. Only the deployed test studio runs identical code, and it has no
  eval driver yet.
