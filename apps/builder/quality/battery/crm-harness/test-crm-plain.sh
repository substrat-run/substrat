#!/bin/zsh
# test-crm-plain.sh — the CRM tester on every plain CRM build, three at a time, from now on, on ports
# 19700-19790. test-crm.sh skips any build this one has started (it checks out/stdout.log).
# Tests live in $CHECKS_WORK/battery/tests/<id>/{app,out}, cloned from the builds' working folders.
P=${0:A:h}; REPO=${P:h:h:h:h:h}; H=${BUILDER_RUNS:-$REPO/data/builder-runs}
BW=${CHECKS_WORK:-$REPO/.builder/checks}/battery
export BATTERY_APP=crm
slot=0; k=0
go() {
  [ -f $BW/tests/$1/out/stdout.log ] && return
  mkdir -p $BW/tests/$1/out; : > $BW/tests/$1/out/stdout.log   # claim it before the tester starts
  k=$((k + 1)); $P/run-tester.sh $BW/tests/$1/app $((19700 + 10 * (k % 10))) $BW/tests/$1/out opus &
  slot=$((slot + 1)); [ $slot -ge 3 ] && { wait; slot=0; }
}
round() {
  for D in $H/runs/sales-team-plain-*(N); do
    id=${D:t}; [ -d $D/project ] || continue
    [ -d $BW/tests/$id/app ] || { mkdir -p $BW/tests/$id; cp -Rc $BW/work/$id $BW/tests/$id/app; }
    go $id
  done
}
while pgrep -f "crm-harness/build-cr[m].sh" > /dev/null; do round; wait; slot=0; sleep 60; done
round; wait
echo "== all plain crm tests done $(date +%T)"
