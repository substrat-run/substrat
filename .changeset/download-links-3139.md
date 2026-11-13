---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': patch
'create-substrat': patch
---

contracts: download links, the read-side counterpart of upload links: the mint input, the path, and two kernel-authored events (`attachment.download-link-minted`, `attachment.download-link-revoked`).
kernel: `ctx.attachments.mintDownloadUrl` and `revokeDownloadLink`; `ScopeHost.openDownloadLink` reads one file as the principal who minted the link, re-checking their read key on every read.
adapter-sqlite: download links, in a new `_substrat_download_links` spine table that a copy leaves behind.
adapter-cloudflare: download links, in a new `_substrat_download_links` spine table that a copy leaves behind.
contract-tests: `downloadLinkContractSuite`, which both adapters run.
vertical-host: `mountDownloadLinkRedeem` serves a download link's file, streamed and seekable, and `workerDoor({ attachments: true })` mounts it; the invocation log redacts its secret.
control-plane-api: the platform entry re-emitted, so a pushed vertical's invocation log redacts a download link's secret.
create-substrat: the template's comment names download links.
