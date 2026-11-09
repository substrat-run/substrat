#!/bin/zsh
# test-crm.sh — the CRM tester, three at a time: builder lane 5, the calibration copies, then every
# plain CRM build as it finishes (cloned copy-on-write, so the build stays as it was left).
# Skips anything already tested or started; keeps going while the CRM build loop is still running.
# Tests live in $CHECKS_WORK/battery/tests/<name>/{app,out}; crm-builder-map.txt names the builder builds.
P=${0:A:h}; REPO=${P:h:h:h:h:h}; H=${BUILDER_RUNS:-$REPO/data/builder-runs}
BW=${CHECKS_WORK:-$REPO/.builder/checks}/battery
export BATTERY_APP=crm
slot=0; k=0
go() {  # go <test-dir-name>
  [ -f $BW/tests/$1/out/stdout.log ] && return
  k=$((k + 1)); $P/run-tester.sh $BW/tests/$1/app $((19900 + 10 * (k % 9))) $BW/tests/$1/out opus &
  slot=$((slot + 1)); [ $slot -ge 3 ] && { wait; slot=0; }
}
plains() {
  for D in $H/runs/sales-team-plain-*(N); do
    id=${D:t}; [ -d $D/project ] || continue
    [ -d $BW/tests/$id/app ] || { mkdir -p $BW/tests/$id; cp -Rc $BW/work/$id $BW/tests/$id/app; }
    go $id
  done
}
go crm-builder-05
for n in $(cut -d' ' -f1 $P/crm-cal-map.txt); do go $n; done
while pgrep -f "crm-harness/build-crm.sh" > /dev/null; do plains; wait; slot=0; sleep 60; done
plains; wait
echo "== all crm tests done $(date +%T)"
