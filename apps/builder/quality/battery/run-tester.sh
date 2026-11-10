#!/bin/zsh -i
# run-tester.sh <app-dir> <port> <out-dir> [model] — the tester writes battery/ in a build, then the
# harness replays it from fresh starts into <out-dir>/battery.json. App files are hashed before and
# after; a tester that changed one is recorded, and its verdicts do not count.
P=${0:A:h}; APP=${1:A}; PORT=$2; OUT=$3; M=${4:-opus}
# The tester drives a browser through playwright-core: PLAYWRIGHT_CORE, or the copy node resolves from here.
PLAYWRIGHT=${PLAYWRIGHT_CORE:-$(node -e 'try { console.log(require("path").dirname(require.resolve("playwright-core/package.json", { paths: [process.argv[1]] }))) } catch {}' $P)}
[ -n "$PLAYWRIGHT" ] || { echo "run-tester: no playwright-core: run \`npx playwright install chromium\`, then set PLAYWRIGHT_CORE to the playwright-core package directory"; exit 2; }
mkdir -p $OUT $APP/battery/checks
cp $P/battery.py $APP/battery/_harness.py
sed "s|{{PLAYWRIGHT_CORE}}|$PLAYWRIGHT|g" $P/tester.md > $OUT/tester.md
# Not `hash`: this runs under `zsh -i`, and a profile cd hook calling the `hash` builtin would call
# this function instead, which cds and calls the hook again, spawning the script without end.
app_sums() { (cd $APP && find . -path ./battery -prune -o -name node_modules -prune -o -name .git -prune -o -type f -print | sort | grep -vE '\.(db|sqlite3?|db-wal|db-shm|log)$|/data/|/outbox/|/\.data/' | xargs shasum 2>/dev/null) }
app_sums > $OUT/before.sha
ALLOW=$PLAYWRIGHT${TESTER_ALLOW:+:$TESTER_ALLOW}
PORT=$PORT OIDC_ISSUER=http://localhost:18800 node $P/run-agent.mjs --cwd $APP --prompt $OUT/tester.md --out $OUT --model $M --max-turns 300 --minutes 60 --allow $ALLOW > $OUT/stdout.log 2>&1
app_sums > $OUT/after.sha
diff $OUT/before.sha $OUT/after.sha > $OUT/tampered.diff && rm $OUT/tampered.diff
OIDC_ISSUER=http://localhost:18800 python3 $P/battery.py replay $APP $PORT $OUT/battery.json > $OUT/replay.txt 2>&1
echo "== tested $APP $(date +%T) $(tail -1 $OUT/stdout.log)"
