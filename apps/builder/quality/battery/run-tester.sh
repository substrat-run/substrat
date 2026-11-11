#!/bin/zsh
# run-tester.sh <app-dir> <port> <out-dir> [model] — the to-do tester. One tester serves both
# batteries, so a fix lands once: this is crm-harness/run-tester.sh with BATTERY_APP=todo.
BATTERY_APP=todo exec ${0:A:h}/crm-harness/run-tester.sh "$@"
