#!/bin/zsh
# run-tester.sh <app-dir> <port> <out-dir> [model] — the tester (both batteries; ../run-tester.sh is
# this with BATTERY_APP=todo) writes battery/ in a build, then the
# harness replays it from fresh starts into <out-dir>/battery.json. App files are hashed before and
# after; a tester that changed one is recorded, and its verdicts do not count.
source ${0:A:h}/../../path.sh  # node on PATH without the profile; see path.sh
P=${0:A:h}; B=${P:h}; APP=${1:A}; PORT=$2; OUT=$3; M=${4:-opus}
# BATTERY_APP=crm switches the brief, the check set and the limits to the sales-team battery.
export BATTERY_APP=${BATTERY_APP:-todo}
PROMPT=$B/tester.md; TURNS=300; MINUTES=60
[ $BATTERY_APP = crm ] && { PROMPT=$P/tester-crm.md; TURNS=500; MINUTES=150; }
# The tester drives a browser through playwright-core: PLAYWRIGHT_CORE, or the copy node resolves from here.
PLAYWRIGHT=${PLAYWRIGHT_CORE:-$(node -e 'try { console.log(require("path").dirname(require.resolve("playwright-core/package.json", { paths: [process.argv[1]] }))) } catch {}' $P)}
[ -n "$PLAYWRIGHT" ] || { echo "run-tester: no playwright-core: run \`npx playwright install chromium\`, then set PLAYWRIGHT_CORE to the playwright-core package directory"; exit 2; }
mkdir -p $OUT $APP/battery/checks
cp $P/battery.py $APP/battery/_harness.py
sed "s|{{PLAYWRIGHT_CORE}}|$PLAYWRIGHT|g" $PROMPT > $OUT/${PROMPT:t}
# Every app file but the battery, installs, databases and logs, NUL-separated so a name with a
# space or a quote is hashed like any other (split on whitespace, it went unhashed, and so did
# everything after a quote). A file that cannot be read says so rather than dropping out.
app_sums() {
  (cd $APP && find . \( -path ./battery -o -name node_modules -o -name .git -o -path '*/data' -o -path '*/outbox' -o -path '*/.data' \) -prune \
    -o -type f ! -name '*.db' ! -name '*.sqlite' ! -name '*.sqlite3' ! -name '*.db-wal' ! -name '*.db-shm' ! -name '*.log' -print0 \
    | sort -z | xargs -0 shasum)
}
app_sums > $OUT/before.sha
ALLOW=$PLAYWRIGHT${TESTER_ALLOW:+:$TESTER_ALLOW}
PORT=$PORT OIDC_ISSUER=http://localhost:18800 node $B/run-agent.mjs --cwd $APP --prompt $OUT/${PROMPT:t} --out $OUT --model $M --max-turns $TURNS --minutes $MINUTES --allow $ALLOW > $OUT/stdout.log 2>&1
app_sums > $OUT/after.sha
diff $OUT/before.sha $OUT/after.sha > $OUT/tampered.diff && rm $OUT/tampered.diff
OIDC_ISSUER=http://localhost:18800 python3 $P/battery.py replay $APP $PORT $OUT/battery.json > $OUT/replay.txt 2>&1
echo "== tested $APP $(date +%T) $(tail -1 $OUT/stdout.log)"
