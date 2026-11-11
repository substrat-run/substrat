#!/bin/zsh
# hosted-all.sh <run-id>... : verify-hosted.py on each archived run, borrowing node_modules from the
# lane that built it (<LANE_ROOT>/.builder/projects/eval-<lane>-todo). One line per run; the full
# output is kept in $CHECKS_WORK/verify-hosted/<run-id>.out. LANEROOT is this script's older name for LANE_ROOT.
source ${0:A:h}/../path.sh  # node on PATH without the profile; see path.sh
HERE=${0:A:h}; REPO=${HERE:h:h:h:h}
D=${CHECKS_WORK:-$REPO/.builder/checks}
R=${BUILDER_RUNS:-$REPO/data/builder-runs}/runs
LANEROOT=${LANEROOT:-${LANE_ROOT:-$REPO}}
[[ $LANEROOT = /* ]] || LANEROOT=$REPO/$LANEROOT
mkdir -p $D/verify-hosted
for id in "$@"; do
  lane=$(echo $id | grep -o -- '-l[0-9]*-' | tr -d 'l-')
  out=$D/verify-hosted/$id.out
  python3 $HERE/verify-hosted.py $R/$id/project --node-modules $LANEROOT/.builder/projects/eval-$lane-todo --expect ok > $out 2>&1
  echo "$id exit $? :: $(grep '^HOSTED' $out | head -1)"
done
echo HOSTED_DONE
