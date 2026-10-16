---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/control-plane-client': patch
'@substrat-run/cli': patch
'@substrat-run/control-plane': patch
'@substrat-run/dashboard-web': patch
---

Scope stores: a key revocation or a store entry fix now reaches every store script without a push (#2309).

- **Control plane:** what the platform builds every store script from (both key lists, the entry, its verifier and the compatibility flags) is one digest, `storePlatformFingerprint`. The scheduled pass rebuilds every existing store script whose build is older than it, at the release the script already runs, and never moves a script to another release or creates one. Each pass walks a bounded number of scripts (`STORE_REBUILD_SUBREQUESTS`, default 500 subrequests, 5 a script) from a per-driver cursor and resumes there on the next pass. It runs under the shared hold a push takes, so a rollout or rollback excludes it and a paused rollout keeps its scripts where they are. A script it could not rebuild is retried on every pass and recorded as an ops failure.
- **API and CLI:** `GET /store-drivers/:driver` adds `rebuild`: whether every script is current, and the scripts that may not be. `POST /store-drivers/:driver/rebuild` runs a pass now, for a person only (as the other release writes), audited as `rebuildStoreDriver`. `substrat store-driver rebuild --driver <driver>` calls it, and `store-driver status` prints the rebuild's state.
- **Kernel and adapters:** a `store_driver_rebuilds` directory table and three `HostAdmin` methods (`storeDriverRebuild`, `claimStoreDriverRebuild`, `advanceStoreDriverRebuild`), plus `recordStoreDriverRebuildRun` for the audit row. The row's lease keeps two passes from walking one driver at once. A new fingerprint restarts the walk.
- **Runbook:** `secrets/store-keys.md` says how long the rebuild takes for a fleet size. It also says that an old key counts as revoked only once `store-driver status` reads `scripts: current`.
