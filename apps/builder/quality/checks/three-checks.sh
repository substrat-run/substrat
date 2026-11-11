#!/bin/zsh
# three-checks.sh <label> <run-id-prefix>... : the three checks on every archived run whose id starts with a prefix.
# Each borrows node_modules from LANE_ROOT (default: this checkout). Point LANE_ROOT at a folder whose
# .builder/projects/eval-<N>-todo are symlinks to one idle lane, so a batch reinstalling lanes cannot disturb them.
# Logs land in $CHECKS_WORK: <label>-ids.txt, verify-<label>.log, hosted-<label>.log, ui-<label>.log.
source ${0:A:h}/../path.sh  # node on PATH without the profile; see path.sh
HERE=${0:A:h}; REPO=${HERE:h:h:h:h}
# Absolute, since this script changes folder; two steps, since zsh's :A on a nested default garbles its '-'.
CHECKS_WORK=${CHECKS_WORK:-$REPO/.builder/checks}; export CHECKS_WORK=${CHECKS_WORK:A}
BUILDER_RUNS=${BUILDER_RUNS:-$REPO/data/builder-runs}; export BUILDER_RUNS=${BUILDER_RUNS:A}
export LANE_ROOT=${LANE_ROOT:-$REPO}
[[ $LANE_ROOT = /* ]] || LANE_ROOT=$REPO/$LANE_ROOT
D=$CHECKS_WORK
L=$1; shift
mkdir -p $D; cd $D
: > $D/$L-ids.txt
for p in "$@"; do ls $BUILDER_RUNS/runs | grep "^$p" >> $D/$L-ids.txt; done
IDS=( $(cat $D/$L-ids.txt) )
NM_HOME=1 python3 $HERE/verify-full.py "${IDS[@]}" > $D/verify-$L.log 2>&1
LANEROOT=$LANE_ROOT $HERE/hosted-all.sh "${IDS[@]}" > $D/hosted-$L.log 2>&1
OUT_ROOT=$D/verify-ui $HERE/verify-ui.sh "${IDS[@]}" > $D/ui-$L.log 2>&1
echo VERIFY_DONE >> $D/verify-$L.log
