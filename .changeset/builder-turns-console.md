---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
---

contracts: `builderTurn` and its page and detail schemas, the summary of one builder-studio turn (outcome, red gates, repairs, tokens, its range in the conversation record).
control-plane-api: staff-only `GET /builder-turns` and `GET /builder-turns/:turnId`, relayed from the builder studio, with `listBuilderTurns`/`getBuilderTurn` on the staff client.
