---
'@substrat-run/dashboard': patch
'@substrat-run/cli': patch
---

The generated PR-preview workflow turned every preview job red on a shell-quoting bug,
and hid the deploy failure underneath it. The comment step built its body with a
single-quoted `printf` whose prose read `Runs this PR's code` — the apostrophe closed the
quote and bash died with `syntax error near unexpected token '('`. Reword to drop the
apostrophe.

Underneath that, the preview never actually deployed: `preview create` returned
`400: invalid request` and exited non-zero, but `... | tee preview.out` (no `pipefail`)
swallowed the exit code, and `grep 'https://…'` then grabbed the wrangler *deploy-endpoint*
URL as if it were the preview URL — so the job carried on to the (broken) comment step.
Add `set -euo pipefail` so a failed push fails the step, and take the URL only from the
CLI's `✓ preview … →` success line.

Finally, the CLI's HTTP helper threw away the control-plane's Zod `issues` array (reading
only `.error`), which is exactly why a preview `400` surfaced as a bare, undiagnosable
`invalid request`. It now appends the failing field paths so the operator can see what was
rejected.
