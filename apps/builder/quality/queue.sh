#!/bin/zsh -i
# queue.sh <strategy> <model> <count> [eval args...] — from a checkout; a bare model runs on the
# Claude Code login, and one with a provider runs as named (cloudflare:@cf/...); runs serially, stops if disk runs low.
# Runs land in $BUILDER_RUNS (default data/builder-runs, which is gitignored).
S=$1; M=$2; N=$3; shift 3
[[ $M == *:* ]] && SPEC=$M || SPEC=claude-code:$M
LABEL=${M##*/}
HERE=${0:A:h}
H=${BUILDER_RUNS:-$PWD/data/builder-runs}
SHA=$(git rev-parse --short HEAD)
for i in $(seq 1 $N); do
  free=$(df -g "$PWD" | awk 'NR==2{print $4}')
  [ "$free" -lt 8 ] && { echo "stop: ${free}G free"; exit 3; }
  ID=$S-$LABEL-$(date +%m%d-%H%M%S); D=$H/runs/$ID; mkdir -p $D
  echo "== $ID $(date +%T)"
  pnpm builder evals --eval todo --model $SPEC --quiet "$@" > $D/stdout.log 2>&1; code=$?
  R=$(ls -t .builder/evals/*.json 2>/dev/null | head -1)
  [ -n "$R" ] && [ "$R" -nt $D ] && cp "$R" $D/report.json && cp "${R%.json}.todo.log" $D/transcript.log 2>/dev/null
  mkdir -p $D/project
  (cd .builder/projects/eval-todo 2>/dev/null && tar --exclude node_modules --exclude dist --exclude .git -cf - .) | tar -xf - -C $D/project
  node $HERE/score.mjs $D $S $LABEL $SHA $code
done
