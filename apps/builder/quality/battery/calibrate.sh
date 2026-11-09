#!/bin/zsh
# calibrate.sh — the tester on every calibration copy, four at a time, then a comparison with truth.
# The copies are $CHECKS_WORK/battery/tests/cal-NN/app (cal-map.txt names which planted hole each holds).
P=${0:A:h}; T=${CHECKS_WORK:-${P:h:h:h:h}/.builder/checks}/battery/tests
run() { n=$1; i=${n#cal-0}; $P/run-tester.sh $T/$n/app $((19400 + 10 * i)) $T/$n/out opus; }
for n in cal-01 cal-02 cal-03 cal-04; do run $n & done; wait
for n in cal-05 cal-06 cal-07 cal-08; do run $n & done; wait
echo "== calibration done $(date +%T)"
