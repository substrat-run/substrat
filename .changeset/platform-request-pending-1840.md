---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
---

`GET /platform-requests/backlog` now also reports how many platform requests are still waiting (#1840). Until now it counted only the requests the platform had given up on, because a waiting request lives in its app's own storage and nothing indexed it across the fleet. The platform's scheduled sweep already visits every active app to deliver those requests, so each pass now records what it found as one sweep-run row: a new `platform-request` kind, unit `fleet`, with the pass's totals in a new `platformRequests` field. The route reads the newest of those rows and returns `pending: { count, asOf, floor }`, where `asOf` is when that pass ran. The count is only as fresh as the last pass. `pending` is `null` when no pass is on record, which is a different answer from `0`. `floor` is true when that pass could not reach every app, so the real number may be higher. The existing fields are unchanged. An app cannot write this row: a batch of sweep results sent from an app's own storage that claims the `platform-request` kind is refused.
