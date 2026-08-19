---
id: D-50
date: 2026-08-15
layer: plan
title: "The LLM is pluggable at the generator seam, and running any provider is a requirement"
status: accepted
aliases: []
tracking: []
source: docs/architecture/builder/studio.md §13
---

# D-50 — The LLM is pluggable at the generator seam, and running any provider is a requirement

> **Ratified 2026-08-19.** Transcribed from docs/architecture/builder/studio.md §13 during the Phase-2 log
> split, which found this decision built but never written into the log. The text is
> the author's; only the id is new.

**The LLM is pluggable at the generator seam, and running any provider is a requirement.** A `VerticalGenerator` produces our `BuildEvent` union over a `Workspace`; the default implementation uses the Vercel AI SDK with `Workspace` methods as the model's tools, so provider is config and no credential enters the sandbox.

## Why

The prompt (files) and the verification (exit codes) are already provider-neutral for free, so the only real question was where the harness binds — and a hard any-LLM requirement rules out the Claude Agent SDK and Managed Agents as the *core*, leaving them as optional implementations behind the same seam. The honest bound: architecture permits any model, `evals/` decides which ones can actually pass the gates, and that list is expected to be short.
