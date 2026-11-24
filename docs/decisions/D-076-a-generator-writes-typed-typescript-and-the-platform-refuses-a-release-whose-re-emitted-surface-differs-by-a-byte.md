---
id: D-76
date: 2026-11-24
layer: plan
title: "A generator writes typed TypeScript, and the platform refuses a release whose re-emitted surface differs by a byte"
status: accepted
aliases: []
amends: []
tracking: ["#3378", "#3381"]
---

# D-76 — A generator writes typed TypeScript, and the platform refuses a release whose re-emitted surface differs by a byte

> **Accepted 2026-11-24.** It answers the first two of phase 0's open questions in
> [one-model-for-shipped-code.md](../rfc/one-model-for-shipped-code.md): the generation target and
> the surface check. Both were raised by an addendum that takes the model as the source of an app's
> code. Nothing in it is built.

**A generator writes typed TypeScript, against the same API a hand-written app uses.** For an app
whose model is kept elsewhere, the generator writes `spec/model.ts` and, once the target form
exists, the rest of that form: the modules' declarations, the dependency, and the generated entry
(#3378), as one chain under the rules for generated files. What runs is that TypeScript. The
platform does not load a data description of an app and execute it, and written code is not fitted
into slots of one. An app written by hand and an app generated from a model have one form (D-75),
and engines keep composing by call.

**The types, the manifest and the routes follow from `spec/model.ts` deterministically.** The types
are TypeScript's own inference. The manifest and the HTTP routes are derived from the same objects
at build or mount time. The emitted files `model.json`, `openapi.json` and `PERMISSIONS.md` are
derived from `spec/model.ts` and the modules too, and nothing at run time reads them. They are what
a reviewer reads, what the platform records per version, and what K-65's classifier and the
permission checkpoint compare.

**The platform refuses a release whose re-emitted surface differs by a byte (answering question
2).** The platform builds every release from a source revision
([D-66](./D-066-projects-use-github-or-artifacts-and-the-platform-builds-every-release.md)). In that
build it re-emits `model.json`, `openapi.json` and `PERMISSIONS.md` from the revision's source,
with the emitter versions the app pinned
([K-65](./K-065-one-version-rule-an-install-follows-its-app-within-a-major-and-a-breaking-change-is-a-new-major-served-beside-the-old.md)),
and compares each with the file the revision carries. If any differs by a byte, the release is
refused. A missing file, where the app's source declares what it would describe, is a difference
too. So the check is a refusal by the platform, not only a check in CI. An app's CI keeps its
`--check` re-emits, which catch the same thing before a push.

**An emitter's output is part of its contract.** The same input gives the same bytes: a stable
order, one line ending, and no time, path or machine in the output. A change in what an emitter
writes for the same input is a change of its major under K-65, because it would refuse releases
that passed before.

## Why

**One form of code, and one set of guarantees for both kinds of author.** Generating typed
TypeScript keeps the type checker as the first gate, which already refuses a handler for an
operation that is not declared (`BoundOperations`). It needs no second way to write an app, and no
rework of how the kernel registers modules. A data surface that the platform executes would have
given every hand-written app and engine a second structure to move to. And because its binding runs
in the app's own isolate, it still would not stop an app that means to get around it.

**The refusal closes the gap between what is reviewed and what is released.** Today the three files
are held to the source by re-emits in this repository's CI, and in an outside app's CI if it has
one. A hand edit to a generated file, or a source change pushed without re-emitting, reaches the
platform's record, the dashboard's Model tab and the version classifier as a surface the code does
not have. Re-emitting in the platform's own build makes the recorded surface the one the source
produces, for every app, whoever wrote it. It is the same test the addendum's round trip uses to
decide that an app may move to a generated model: byte for byte, with no new migration.

**What it does not prove.** It proves that the files match the source. It does not prove that the
bundle can do nothing beyond what they declare, because code in the app's isolate is the app's own.
The boundary for that is outside the isolate: the door can route only what the recorded surface
declares, and that is separate work.

## Not built

- **The emitters as a published package the app pins.** Today they are this repository's tools
  (`tools/model-diff.mts`, `tools/api-diff.mts`, `tools/permission-diff.mts`). The platform's build
  needs them in the version the app pinned.
- Byte-for-byte determinism held by a test, for each emitter.
- The re-emit step in the source build, and the refusal with the differing file named.

## Not decided here

- Regenerating the generated sources themselves (`spec/model.ts` and the rest) from the model
  revision at release, for an app built from a model. Until the platform can read a model
  revision, the generator's own check holds that half.
- Question 3 of phase 0, the model's boundary.
