#!/bin/zsh
# Browser click-through check for generated todo apps.
#   verify-ui.sh <run-id> [<run-id> …]                  e.g. full-worker-sonnet-l3-1108-001715
#   verify-ui.sh --project <dir> --lane <N> [--label x]  a project dir + the lane whose node_modules it uses
# Prints one `UI create=… open=… … delete-list=…` line per build; details, screenshots and
# result.json land in $OUT_ROOT/<label>/ (default $CHECKS_WORK/verify-ui). Boots on ports 19300+ (never the builds' defaults).
source ${0:A:h}/../path.sh  # node on PATH without the profile; see path.sh
exec node ${0:A:h}/verify-ui.cjs "$@"
