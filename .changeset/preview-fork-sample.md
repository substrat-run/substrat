---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
---

Preview forks can copy less than all of prod (#3232). `substrat preview create --sample <n>` copies the newest n rows of each table, among those whose parents it copied, and the events, attachments, grants and links about them. `--max-rows <n>` counts the rows a fork would copy before it starts and refuses it above n, with the count and the largest tables; `--sample-over-cap <n>` copies that sample instead. The generated deploy workflow passes them from the `SUBSTRAT_PREVIEW_SAMPLE`, `SUBSTRAT_PREVIEW_MAX_ROWS` and `SUBSTRAT_PREVIEW_SAMPLE_OVER_CAP` repository variables; unset, a preview copies prod whole as before.
