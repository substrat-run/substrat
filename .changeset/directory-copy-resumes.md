---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

The control plane's daily directory copy succeeds again. A copy that outgrew one scheduled pass was cut off and left its snapshot behind, and every later attempt then failed while dropping it and resetting the directory. The leftover is now dropped in its own steps, a copy longer than its budget pauses and the next pass resumes it, and a failed or cut-off copy is recorded as an ops failure. `DirectoryBackupStore.lastAttempt` now returns the attempt record, which can carry a paused copy.
