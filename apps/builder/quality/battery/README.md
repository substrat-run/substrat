# Plain Claude Code against the builder

The same todo brief built by plain Claude Code (no platform) in two arms, and attacked, with the
builder's full-stack builds, by one calibrated tester. [../CHECKS.md](../CHECKS.md) has the setup, the
environment variables and the commands; results land in `$BUILDER_RUNS` (`plain-battery.json`,
`plain-calibration.json`, and plain rows in `runs.jsonl`).

| File | What |
|---|---|
| `briefs/plain-asked.md`, `briefs/plain-features.md` | What each plain arm is handed |
| `run-agent.mjs` | One Claude Code session through the Agent SDK: claude_code prompt and tools, auto mode, `settingSources: []`, usage counted per request as the builder counts it |
| `guard.mjs` (`guard-test.mjs`) | The PreToolUse guard for a shared machine: no killing what the run did not start, no global installs, no reading outside its folder and its own scratch folder. `GUARD_VERSION` 4 is the one runs are judged on |
| `build-arms.sh` | `build-arms.sh <rounds>`: one build per arm per round, one at a time |
| `issuer.sh`, `personas.mjs` | The dev issuer on :18800 with a neutral cast (alice, bob, carol, dana) |
| `tester.md` | The tester's brief: the world, the doors, the fifteen checks, the file contract |
| `battery.py` | Replays a tester's `battery/` from fresh starts (`replay`), one check (`one`), or ground truth on a reference copy (`truth`) |
| `ref/`, `make-copies.py`, `refcheck.py`, `cal/*.truth.json` | The reference app, its seven planted-hole copies, and the known answers |
| `run-tester.sh`, `calibrate.sh`, `test-arms.sh`, `compare.py` | Run the tester; calibrate it; test the arms; compare calibration with truth |
| `cal-map.txt`, `builder-map.txt` | Which test folder holds which calibration copy, and which builder run |

Everything a run writes (working folders, test copies, calibration copies, logs) goes to
`$CHECKS_WORK/battery`, never into this folder.

## The sales-team CRM (same day, second brief)

`crm/` holds the brief; `crm-harness/` the CRM battery (`tester-crm.md`, 13 holes and 15 features), the
build and test runners, the calibration copies (`make-copies-crm.py`, eight on the golden and one on a
plain build) and the known-answers comparison (`crm-calibration.py`). The golden, CRM golden v1
(`golden-crm-v1`), is builder lane 2's build with `golden-fixes.py` applied (CSV cells a spreadsheet would
run are opened as text; the deal and contact forms pick a company by name), and its reviewed battery. It
is not in the repo yet. `crm-harness/battery.py` and `crm-harness/run-tester.sh` are the to-do ones with a
`BATTERY_APP=crm` switch, and serve both briefs.
