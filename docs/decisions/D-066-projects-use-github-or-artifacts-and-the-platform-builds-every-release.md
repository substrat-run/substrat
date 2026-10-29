---
id: D-66
date: 2026-10-28
layer: plan
title: "Projects use GitHub or Cloudflare Artifacts and the platform builds every release"
status: accepted
aliases: []
tracking: []
---

# D-66 — Projects use GitHub or Cloudflare Artifacts and the platform builds every release

**A tenant-owned project has one authoritative source repository, hosted in the tenant's
GitHub or in Cloudflare Artifacts. Every release is built by the platform from an immutable
source revision.** The builder, GitHub integration and CLI feed the same pipeline and keep
the same project identity. `substrat push` persists selected local source, including
uncommitted changes, in Artifacts before requesting a build. Client-built module uploads
are retired. Built modules remain immutable internal release outputs for deployment,
promotion and rollback.

This replaces [D-53](./D-053-a-generated-vertical-s-repo-is-hosted-by-us-as-a-git-bundle-.md).
Existing builder projects need no preservation, import, migration or compatibility path.
R2 Git bundles cease to be a repository backend; R2 can still hold release outputs, logs
and caches. Retiring the storage path does not authorize deleting tenant data or unrelated
deployments. Implementation: [builder studio §4.5–4.6](../architecture/builder/studio.md#45-source-persistence).

## Why

Source storage and release production should not depend on which tool the builder used.
A shared project identity makes a CLI-created vertical editable in the builder, while a
platform build ties checks to the bytes actually deployed. GitHub serves tenants with an
existing repository workflow; Artifacts supplies Git-compatible hosted repositories for
builder sessions and CLI snapshots. Supporting R2 bundles as a third repository backend
adds another persistence path without a preservation requirement.

Cloudflare describes Artifacts as versioned file and project storage with a Git-compatible
interface: [Artifacts documentation](https://developers.cloudflare.com/artifacts/).
