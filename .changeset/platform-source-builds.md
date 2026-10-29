---
"@substrat-run/cli": minor
"@substrat-run/contracts": minor
"@substrat-run/control-plane-api": minor
---

Build releases on the platform from tenant projects stored in GitHub or Cloudflare Artifacts. CLI push and preview submit source snapshots, and builder projects use the same repository and release pipeline with pinned source and toolchain provenance.

This changes the deploy protocol: client-built module uploads and the builder's R2 Git bundles are no longer supported. Deploy the source builder and control plane together, then update the CLI. Existing builder projects are not migrated.
