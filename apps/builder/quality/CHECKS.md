# The real checks and the comparison battery

The judge (`score.mjs`) reads a build and grades it against the rubric. That is not enough: it
scored apps at 100 that could not be served, or whose UI could not be opened, and it scored two
starter versions 100 alike where only a click-through told them apart (2 of 5 against 5 of 5). These
scripts run what a build produced and judge outcomes, not status codes: did the person get the list
or not.

`checks/` runs three checks on archived `todo` runs. `battery/` builds the same brief with plain
Claude Code and attacks both kinds of build with one calibrated tester ([battery/README.md](battery/README.md)).

## The three checks

| Script | What it proves |
|---|---|
| `checks/verify-full.py` | The API flows, as real people through the dev issuer's tokens: the owner joins, creates a list, adds and ticks an item; invites someone who has not joined, who receives the list after joining; shares with a joined person, who may add but not delete or share onward; revokes, and the revoked person is refused. Plus an attack: a person claims an invited address at their first join, and must receive nothing (`attack: a claimed address receives nothing`). Up to 24 checks, with the operation names and the cast read from the build's own model and personas. |
| `checks/verify-hosted.py` | The build as deployed: its own `src/worker.ts` under `wrangler dev --local`, provisioned and configured through `/internal/*` as the platform does, the owner signed in through the dev issuer's OIDC round trip, creates a list and sees it; a second person, invited by email, signs in and sees it too; the app is served at `/` and at a deep link. Prints one `HOSTED …` line; exits 0 when the outcome matches `--expect`. |
| `checks/verify-ui.cjs` | A headless browser click-through, as a person: create, open, add, tick, delete item, share, revoke, delete list. `ok`, `fail` (the control was there and used, the effect did not show), `missing` (no control a person could find) or `blocked`. This is the measure for UI changes. |
| `checks/hosted-all.sh`, `checks/verify-ui.sh` | `verify-hosted.py` and `verify-ui.cjs` over run ids. |
| `checks/three-checks.sh` | All three over every archived run whose id starts with a prefix. |

## Before you run them

- `python3` (standard library only), `zsh`, `lsof`, and node 22.13 or later with pnpm on `PATH`. The
  zsh scripts run as `zsh -i`, so your profile's `PATH` applies.
- An installed lane project to borrow `node_modules` from. Archived runs keep none; a `todo` eval run
  leaves `.builder/projects/eval-<lane>-todo` installed (`queue-par.sh`), with the dev issuer, `tsx`,
  Vite and wrangler the checks start.
- The dev issuer. The checks start the one in the borrowed `node_modules`. The battery runs this
  checkout's: `pnpm --filter @substrat-run/dev-issuer build`, then `battery/issuer.sh 18800`.
- A cached Playwright chromium: `npx playwright install chromium`. npx keeps `playwright-core` under
  `~/.npm`; set `PLAYWRIGHT_CORE` to that package directory.
- For the battery, a Claude Code login: `run-agent.mjs` drops `ANTHROPIC_API_KEY` and runs on the
  subscription.
- Free ports: `verify-full.py` runs each build on its own defaults (8879, 8891, 5291); `verify-hosted.py`
  picks from 8899, 8798 and 9349 up; `verify-ui.cjs` from 19300; the battery's issuer is 18800 and its
  testers use 19400 to 19990.

They are written for macOS: `cp -Rc` clones, and the browser lookup knows the macOS chromium builds.

## Environment

| Variable | Default | What |
|---|---|---|
| `BUILDER_RUNS` | `<repo>/data/builder-runs` | The run archive (`runs/<id>`) and the ledger, as `queue.sh` uses it |
| `CHECKS_WORK` | `<repo>/.builder/checks` | Project copies, logs and screenshots; the battery's under `battery/` |
| `LANE_ROOT` | `<repo>` | The checkout whose `.builder/projects/eval-<lane>-todo` lends a run its `node_modules`. Relative to the repo. `hosted-all.sh` also reads its old name `LANEROOT`; `verify-ui.cjs` also takes the `.builder/projects` folder itself |
| `NM_HOME` | unset | `verify-full.py` borrows from the run's own lane only when it is set |
| `NM_FALLBACK` | `<LANE_ROOT>/.builder/projects/eval-todo` | What `verify-full.py` borrows otherwise, or when the lane has no install |
| `OUT_ROOT` | `$CHECKS_WORK/verify-ui` | Where `verify-ui.cjs` writes |
| `VUI_PORT_BASE` | `19300` | `verify-ui.cjs`'s first port |
| `PLAYWRIGHT_CORE` | resolved from the script | The `playwright-core` package directory |
| `PLAYWRIGHT_BROWSERS_PATH` | `~/Library/Caches/ms-playwright` | Where `verify-ui.cjs` looks for chromium |
| `BATTERY_APP` | `todo` | `crm` switches `crm-harness/run-tester.sh` and `battery.py` to the sales-team battery |
| `TESTER_ALLOW` | none | More path prefixes the tester may read, `:`-separated |

To keep a batch that reinstalls lanes from disturbing a check, point `LANE_ROOT` at a folder whose
`.builder/projects/eval-<N>-todo` are symlinks to one idle lane.

## Commands

From the repo root. The three checks over archived runs:

```sh
apps/builder/quality/checks/three-checks.sh my-batch full-stack-sonnet-l   # every run id with that prefix
NM_HOME=1 python3 apps/builder/quality/checks/verify-full.py <run-id>...
apps/builder/quality/checks/hosted-all.sh <run-id>...
apps/builder/quality/checks/verify-ui.sh <run-id>...                       # or --project <dir> --lane <N>
python3 apps/builder/quality/checks/verify-hosted.py <project-dir> --node-modules <installed-project> --expect ok
```

The plain arms, then the tester on them and on the builder builds `battery/builder-map.txt` names
(each copied, installed, to `$CHECKS_WORK/battery/tests/builder-0N/app`):

```sh
apps/builder/quality/battery/issuer.sh 18800
apps/builder/quality/battery/build-arms.sh 3 sonnet
apps/builder/quality/battery/test-arms.sh
```

The CRM builder arm, then its Opus tester. Start the issuer with the CRM cast first:

```sh
(cd packages/dev-issuer && node dist/cli.js --personas ../../apps/builder/quality/battery/crm-harness/personas-crm.mjs --port 18800 &)
apps/builder/quality/battery/crm-harness/crm-builder.sh . 5                # lanes c1..c5, the sales-team eval
T=.builder/checks/battery/tests/crm-builder-05
mkdir -p $T && cp -Rc .builder/projects/eval-c5-sales-team $T/app
BATTERY_APP=crm apps/builder/quality/battery/crm-harness/run-tester.sh $T/app 19910 $T/out opus
```

`crm-harness/test-crm.sh` does the last step for lane 5, the calibration copies and every plain CRM
build; `crm-harness/build-crm.sh 3 sonnet` builds the plain CRM arms, and `test-crm-plain.sh` tests them.

Calibration: `python3 battery/make-copies.py` writes the reference app's copies to
`$CHECKS_WORK/battery/cal/`; copy each to `tests/<cal-NN>/app` as `cal-map.txt` says, then run
`battery/calibrate.sh` and `python3 battery/compare.py`. `python3 battery/battery.py truth <copy> <port> <out.json>`
re-derives a copy's known answers. The CRM copies come from `crm-harness/make-copies-crm.py`, which
rewrites `crm-cal-map.txt` with its eight; `crm-cal-09`, a plain build's copy, is added by hand.

## Where results land

- `verify-full.py`: `$CHECKS_WORK/verify/<id>/flow.log`, and a summary on stdout.
- `verify-hosted.py`: one work folder per run under `$CHECKS_WORK/verify-hosted/`, logs kept;
  `hosted-all.sh` keeps each run's output as `$CHECKS_WORK/verify-hosted/<id>.out`.
- `verify-ui.cjs`: `$OUT_ROOT/<id>/` with `result.json`, `steps.log`, `serve.log` and screenshots.
- `three-checks.sh`: `$CHECKS_WORK/{verify,hosted,ui}-<label>.log`.
- The battery: each build in `$BUILDER_RUNS/runs/<id>` like a builder run; each tester's verdicts in
  `$CHECKS_WORK/battery/tests/<name>/out/battery.json`, with `report.json`, `replay.txt`, and
  `tampered.diff` when the tester changed the app.
- The ledger: `$BUILDER_RUNS/runs.jsonl`, `plain-battery.json` and `plain-calibration.json`.
  `crm-calibration.py` writes the CRM rows of `plain-calibration.json`. The scripts that fold the
  checks and the battery into `runs.jsonl` and `plain-battery.json` (`record-arm.py`, `record-plain.py`)
  are not in the repo yet.

The CRM golden reference app, `golden-crm-v1`, which the CRM calibration copies are made from, is not
in the repo yet. The CRM scripts expect it, installed, at `$CHECKS_WORK/battery/golden-crm/app`, with
its reviewed verdicts at `golden-crm/out/battery.json`.
