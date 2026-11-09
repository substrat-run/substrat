#!/bin/zsh -i
# build-crm.sh <rounds> [model] — build-arms.sh for the sales-team brief: one build per plain arm per
# round, one at a time, archived as $BUILDER_RUNS/runs/sales-team-plain-<arm>-<model>-<stamp>/.
# The briefs are ../crm/plain-<arm>.md; working folders stay in $CHECKS_WORK/battery/work/<id> for the tester.
S=${0:A:h}; N=$1; M=${2:-sonnet}
B=${S:h}; REPO=${B:h:h:h:h}
H=${BUILDER_RUNS:-$REPO/data/builder-runs}
BW=${CHECKS_WORK:-$REPO/.builder/checks}/battery
mkdir -p $BW
for i in $(seq 1 $N); do
  for ARM in sales-team-plain-asked sales-team-plain-features; do
    free=$(df -Pk $BW | awk 'NR==2{print int($4/1048576)}')
    [ "$free" -lt 4 ] && { echo "stop: ${free}G free"; exit 3; }
    ID=$ARM-$M-$(date +%m%d-%H%M%S); D=$H/runs/$ID; W=$BW/work/$ID
    BRIEF=$B/crm/${ARM#sales-team-}.md
    mkdir -p $D $W; cp $BRIEF $D/brief.md
    echo "== $ID start $(date +%T)"
    OIDC_ISSUER=http://localhost:18800 node $B/run-agent.mjs --cwd $W --prompt $BRIEF --out $D --model $M --max-turns 400 --minutes 90 > $D/stdout.log 2>&1
    mkdir -p $D/project
    (cd $W && tar --exclude node_modules --exclude .git --exclude dist -cf - .) | tar -xf - -C $D/project
    echo "== $ID done $(date +%T) $(tail -1 $D/stdout.log)"
  done
done
echo "== all crm builds done"
