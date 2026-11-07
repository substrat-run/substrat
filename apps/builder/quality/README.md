# quality/ — grading what a build produced

`evals/` says whether a build passed its gates. This says whether the app does what the customer
asked for, which is a different question: one run passed every gate with a UI that could not reach
its server. [docs/architecture/builder/quality-runs.md](../../../docs/architecture/builder/quality-runs.md)
has the method and the results.

| File | What |
|---|---|
| `queue.sh` | Runs the `todo` eval N times and grades each run |
| `score.mjs` | Grades one archived run and appends a row to the ledger |
| `rubric-todo.md` | The 14 judged items, written from the `todo` fixture's brief |
| `runs-2026-11.jsonl` | The ledger of the first 50 runs |
| `controls-2026-11.jsonl` | The scorer's own checks, before any run counted |

```sh
HYPOTHESIS="what this run should show" EVIDENCE="regex the transcript must match" \
  apps/builder/quality/queue.sh my-change sonnet 3
```

It needs a local Claude Code login. Runs and their projects land in the gitignored
`data/builder-runs/`. `todo` is the only fixture with a rubric, because a rubric grades one brief.
A change to the rubric makes earlier scores incomparable, so re-grade the archived runs with it.
