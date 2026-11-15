---
"@substrat-run/cli": minor
"@substrat-run/control-plane": minor
"@substrat-run/contracts": minor
---

A builder can start a code review of a vertical its workspace owns once staff grant the workspace the `review` entitlement: `substrat review upload` names the vertical (`--slug`, default the project's) and prints the record with `--json`, and `substrat review <id>` and `list` read the workspace's reviews. A workspace has at most five reviews in progress and fifty in a 30-day window, and a review's model usage is metered to it. `review` joins `PLATFORM_ENTITLEMENT_KEYS`, so no vertical can declare it.
