#!/bin/zsh -i
# crm-builder.sh <worktree> <lanes> — the builder on the sales-team fixture, one run per lane, all at
# once, each archived into $BUILDER_RUNS/runs/sales-team-builder-sonnet-l<lane>-<stamp>/ like a quality run.
S=${0:A:h}; REPO=${S:h:h:h:h:h}
W=${1:A}; N=$2; H=${BUILDER_RUNS:-$REPO/data/builder-runs}; H=${H:A}  # absolute: this script changes folder
STAMP=$(date +%m%d-%H%M%S)
cd $W
for i in $(seq ${FROM:-1} $((${FROM:-1} + N - 1))); do
  (
    L=c$i; ID=sales-team-builder-sonnet-l$i-$STAMP; D=$H/runs/$ID; mkdir -p $D
    echo "== $ID start $(date +%T)"
    BUILDER_EVAL_LANE=$L pnpm builder evals --eval sales-team --model claude-code:sonnet --quiet > $D/stdout.log 2>&1; code=$?
    R=(.builder/evals/$L/run-*.json(Nom[1]))  # the newest report of this lane, or nothing
    [ -n "$R" ] && cp "$R" $D/report.json && cp "${R%.json}.sales-team.log" $D/transcript.log 2>/dev/null
    mkdir -p $D/project
    (cd .builder/projects/eval-$L-sales-team 2>/dev/null && tar --exclude node_modules --exclude dist --exclude .git -cf - .) | tar -xf - -C $D/project
    echo "== $ID done $(date +%T) exit $code $(grep -E 'PASS|FAIL' $D/stdout.log | tail -1)"
  ) &
done
wait
echo "== builder crm runs done"
