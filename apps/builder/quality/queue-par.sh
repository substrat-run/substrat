#!/bin/zsh -i
# queue-par.sh <strategy> <model> <count> [eval args...] — the runs of one arm, all at once from this
# checkout. For runs of the same code: a change that depends on an earlier result still goes through queue.sh.
# LANE_FROM numbers the lanes, so two arms can run at once. LANES is how many run in all, for the ledger.
S=$1; M=$2; N=$3; shift 3
HERE=${0:A:h}
export LANES=${LANES:-$N}
FROM=${LANE_FROM:-1}
for i in $(seq $FROM $((FROM + N - 1))); do
  BUILDER_EVAL_LANE=$i $HERE/queue.sh $S $M 1 "$@" &
done
wait
