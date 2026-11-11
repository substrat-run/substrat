#!/bin/zsh
# issuer.sh <port> — the dev issuer with the plain arms' cast, in the background; prints its pid.
# Runs this checkout's packages/dev-issuer (built: dist/cli.js); logs to $CHECKS_WORK/battery/issuer-<port>.log.
source ${0:A:h}/../path.sh  # node on PATH without the profile; see path.sh
S=${0:A:h}
REPO=${S:h:h:h:h}
BW=${CHECKS_WORK:-$REPO/.builder/checks}/battery
mkdir -p $BW
cd $REPO/packages/dev-issuer
nohup node dist/cli.js --personas $S/personas.mjs --port $1 > $BW/issuer-$1.log 2>&1 &
echo $!
