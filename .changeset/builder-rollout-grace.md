---
"@substrat-run/builder": patch
---

A builder release no longer stops a source build in flight: the sandbox container's rollout leaves any sandbox younger than an hour on its current image until it ends, so a push that starts while a release rolls out finishes instead of failing with "the source build stopped unexpectedly". To keep every build inside that hour, a source build now has a 45-minute limit, and one that runs past it fails with "the build ran past its 45-minute limit" (#3259).
