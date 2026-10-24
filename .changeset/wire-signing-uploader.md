---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': minor
---

The control plane's uploads can give a deployed vertical what its entry needs to verify a signed envelope (RFC wire-signing, step 2, the uploader). Both uploads, a version's push and the in-place serve a promote does, give the script they go to the router's and the control plane's public key lists, its own name and the state `dual`, as plain configuration each upload rewrites, but only the deployments the control plane's new `WIRE_KEYS_ROLLOUT` setting names: none while it is unset or `off`, one vertical's as a canary (`canary:<vertical>`), or every one (`fleet`). A setting it cannot read gives none and says why in the error log. The lists are checked before they are given, by the function the entry loads them with, and lists it would refuse are not given; the log names the problem, never a key. No upload gives a state other than `dual`. Unset, every upload is exactly what it was before.

Every upload also records what it gave, or why it gave nothing: the capability record a readiness report will read (RFC §7). `@substrat-run/contracts` gains `wireUploadSettings` and `WIRE_UPLOAD_STATE` on its `wire-signing` subpath, and the `wireAuthRecord` and `deploymentWireAuth` schemas and the `recordWireAuth` admin action. `@substrat-run/kernel` gains the optional `HostAdmin.recordWireAuth` (audited) and `listWireAuth` (access-logged), with the directory table both adapters build (`DEPLOYMENT_WIRE_AUTH_DDL`); a vertical's records are removed with it. Both adapters implement them, and `@substrat-run/contract-tests` holds them to one contract, including a refused write or admin row rolling the record back. `@substrat-run/control-plane-api`'s `createControlPlaneApi` takes the settings as `wireUpload`.
