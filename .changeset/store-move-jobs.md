---
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

A backup, or a restore of a backup, whose scope stores take more than one request's budget (300 pages or 20 s) now goes on in a background job instead of refusing (#2854). `POST …/backups` answers 202 with the backup's `capturedAt` while the job writes the store pages and the manifest; asking again with `{ capturedAt }` answers the backup once it is done. `POST …/backups/:capturedAt/restore` answers 202 while the job stages the stores, and the call after it is done loads the scope and commits them. A reap's own backup and a restore of an uploaded dump still refuse past the budget. The API takes the job store as `storeMoveJobs`; the hosted control plane runs it in `ScopeCopyJobDO`.
