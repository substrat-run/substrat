---
'@substrat-run/dashboard': minor
---

Deleting an app now deletes its data. Delete used to archive the app's scope and leave its storage in place indefinitely, and snapshots or test environments kept "until deleted" outlived the app. Now the copies are deleted and the scope is reaped, after the platform takes its backup copy. If no backup can be taken, the app goes offline with its data intact, and Retire on the app type's installs finishes the wipe. Deleting a team still only archives its apps until the tenant's grace window ends.
