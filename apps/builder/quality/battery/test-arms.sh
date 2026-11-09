#!/bin/zsh
# test-arms.sh — the calibrated tester on the five builder builds, then on every plain build that has
# finished on the final guard (v4), three at a time. A plain build is tested on a copy-on-write clone
# of its working folder, so the build itself stays as it was left. Re-running skips what is tested.
# Tests live in $CHECKS_WORK/battery/tests/<name>/{app,out}; builder-map.txt names the builder builds.
P=${0:A:h}; REPO=${P:h:h:h:h}; H=${BUILDER_RUNS:-$REPO/data/builder-runs}
BW=${CHECKS_WORK:-$REPO/.builder/checks}/battery
slot=0
go() {  # go <test-dir-name> <port>
  [ -f $BW/tests/$1/out/battery.json ] && return
  $P/run-tester.sh $BW/tests/$1/app $2 $BW/tests/$1/out opus &
  slot=$((slot + 1)); [ $slot -ge 3 ] && { wait; slot=0; }
}
for l in 1 2 3 4 5; do go builder-0$l $((19500 + 10 * l)); done
k=0
while true; do
  pending=0
  for D in $H/runs/plain-*; do
    id=${D:t}; [ -f $D/report.json ] || { pending=1; continue; }
    v=$(python3 -c "import json;print(json.load(open('$D/report.json'))['results'][0].get('guardVersion') or 0)")
    [ "$v" -ge 4 ] || continue
    if [ ! -d $BW/tests/$id/app ]; then
      while [ ! -d $D/project ]; do sleep 5; done; sleep 5
      mkdir -p $BW/tests/$id; cp -Rc $BW/work/$id $BW/tests/$id/app
    fi
    k=$((k + 1)); go $id $((19600 + 10 * (k % 40)))
  done
  wait; slot=0
  pgrep -f "battery/build-arms.sh" > /dev/null || [ $pending -eq 1 ] || break
  sleep 60
done
echo "== all tests done $(date +%T)"
