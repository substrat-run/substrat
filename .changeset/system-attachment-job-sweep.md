---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
---

Background jobs can now open attachment bytes through a read-only system surface. The host validates the registered module and scope; each open checks the attachment target's read permission against the module's system grant before returning bytes. The Cloudflare and SQLite adapters implement the same `ScopeHost.getSystemAttachments` contract.

The scope sweeper can drive due resumable jobs when `runJobs` is enabled. A deployment can provide `startJobs` and `jobStartIntervalMs` to start or coalesce recurring runs per scope at a paced interval. The callback runs before the job driver, and its last successful start time is kept in the sweeper's durable storage.
