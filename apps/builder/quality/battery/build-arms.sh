#!/bin/zsh -i
# build-arms.sh <rounds> [model] — one plain-asked and one plain-features build per round, one at a
# time (builds start servers on whatever port they like). Each lands in $BUILDER_RUNS/runs/<id>
# like a builder run; its working folder stays in $CHECKS_WORK/battery/work/<id> for the tester.
S=${0:A:h}; N=$1; M=${2:-sonnet}
REPO=${S:h:h:h:h}
H=${BUILDER_RUNS:-$REPO/data/builder-runs}
BW=${CHECKS_WORK:-$REPO/.builder/checks}/battery
mkdir -p $BW
for i in $(seq 1 $N); do
  for ARM in plain-asked plain-features; do
    free=$(df -Pk $BW | awk 'NR==2{print int($4/1048576)}')
    [ "$free" -lt 4 ] && { echo "stop: ${free}G free"; exit 3; }
    ID=$ARM-$M-$(date +%m%d-%H%M%S); D=$H/runs/$ID; W=$BW/work/$ID
    mkdir -p $D $W; cp $S/briefs/$ARM.md $D/brief.md
    echo "== $ID start $(date +%T)"
    OIDC_ISSUER=http://localhost:18800 node $S/run-agent.mjs --cwd $W --prompt $S/briefs/$ARM.md --out $D --model $M --max-turns 300 --minutes 60 > $D/stdout.log 2>&1
    mkdir -p $D/project
    (cd $W && tar --exclude node_modules --exclude .git --exclude dist -cf - .) | tar -xf - -C $D/project
    echo "== $ID done $(date +%T) $(tail -1 $D/stdout.log)"
  done
done
echo "== all builds done"
