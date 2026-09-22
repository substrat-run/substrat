---
'@substrat-run/dashboard': patch
'@substrat-run/dashboard-web': patch
---

Promoting a version now shows what changes in the permission surface before it promotes, and asks for each acknowledgement separately.

The dashboard used to promote, wait for the registry to refuse a change to the permission or migration surface, and then show the refusal in a browser confirm box that carried two digests and nothing else. One OK acknowledged both kinds of change, whichever of them had actually moved. Now the promote dialog opens first, from the registry of the version `prod` serves against the registry of the one you are promoting: new, removed and re-worded permissions, roles that gained or lost a permission, and entity-grant shapes, with a plain line when a promotion only adds or only removes. Each kind of change has its own checkbox, and only a change you were shown and ticked is acknowledged.

A promotion that changes nothing opens no dialog and promotes as before. A version pushed before registries were kept has nothing to diff against, so the dialog says so and still asks for the acknowledgement. If the registry cannot be read, the promotion is blocked with the error instead of proceeding as "no changes".

A changed migration set is still learned from the registry's refusal and asked for in the same dialog, on its own checkbox. The migration SQL is not yet shown: it is not carried in the deploy manifest, which is the second half of the issue.
