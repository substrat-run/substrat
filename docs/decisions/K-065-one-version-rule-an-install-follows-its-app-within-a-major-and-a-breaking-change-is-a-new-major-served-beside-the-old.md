---
id: K-65
date: 2026-11-24
layer: kernel
title: "One version rule: an install follows its app within a major, and a breaking change is a new major served beside the old"
status: accepted
aliases: []
amends: ["K-33"]
tracking: []
---

# K-65 — One version rule: an install follows its app within a major, and a breaking change is a new major served beside the old

> **Accepted 2026-11-24**, from the maintainer's answers in phase 0 of
> [one-model-for-shipped-code.md](../rfc/one-model-for-shipped-code.md) (§6, §7.5). It reconciles
> [marketplace-publish.md](../architecture/marketplace-publish.md) §5.1 with
> [K-33](./K-033-verticals-serve-in-place-from-one-stable-script-per-version-.md) by replacing the
> promise §5.1 made, and it amends K-33. Most of it is not built (below).

**The rule.** Code you import, you pin. What the platform or another app runs for you is versioned
per major, and changes only additively within it. A breaking change is a new major, which lives
beside the old one until a stated date. "You" is the app's owner: the party that pins and pushes.

- **A module, an engine included, is pinned in the app's `package.json`** and bundled at build
  ([D-66](./D-066-projects-use-github-or-artifacts-and-the-platform-builds-every-release.md)).
- **A network part the platform runs, a store driver, and a contract another app serves each have a
  major.** A minor or a patch replaces it in place, and so reaches everyone on that major at once.
- **An app is served from one script per major.** This amends K-33, which serves an app from one
  stable script. Within a major, a promote replaces that script in place and every scope on it
  migrates, as K-33 has it today.

**A tenant that installed a listed app follows the publisher within a major.** There is no per-install
pin: a scope's data belongs to the script that serves it, which is why K-33 gave per-version serving
up. A promote within the major reaches every install, paced as the listed reconcile already paces it.
Each install is told about the update, with K-33's badge (**code-only** or **schema-change**). A
schema-change update applies on its own, without the installer's approval. The net under it is
K-33's: a point-in-time bookmark taken before the migration pass, and the time-boxed `rewindScope`.

**A breaking change is a new major, in its own serving script.** An install moves to it when its
tenant chooses, through the hop K-33 already has (`adopt-serving`: export, restore, flip). The old
major keeps serving, and may still take additive releases, until its end date. The end date is **at
least 90 days after the new major is released**. The publisher may state a later date, and states it
when the new major is released.

**The platform refuses a breaking change within a major.** A promote of a listed app is classified
by the same rules `substrat changeset` writes with and `lint:changeset-bump` checks
(`packages/cli/src/bump.ts`). A removed or narrowed surface is major, and so is anything the
classifier cannot rank. A promote the classifier ranks major is refused unless it goes to a new major.

**The app's owner keeps its own bindings.** An owner may still bind a scope it owns to a version, as
a canary for its own tenants (`substrat scope bind`). This record is about a tenant that installed
someone else's listed app, which holds no such binding and follows.

## Why

**Per-install pinning cannot be kept without a script per install.** A Durable Object's data belongs
to its script, so pinning an install to a version means a serving script per pinned version, the
cost K-33 already refused. marketplace-publish.md §5.1 promised that "nothing changes under a tenant
unasked", and the code has not kept that promise since K-33: a listed promote re-provisions every
install. This record states what is true, and puts the protection where it can hold. A tenant cannot
be broken by a publisher, because a breaking change cannot reach it inside its major.

**Following within a major is safe only if "additive" is enforced.** A promise that a minor is
harmless is broken by mistake as easily as on purpose. The classifier already ranks a model, an API
surface and a permission diff, and it already reddens a changeset that understates its bump. Making
it refuse a listed promote turns the rule into a mechanism.

**A schema-change update cannot wait for each installer.** One script serves every install on the
major. An install that has not approved would be running the new code against a schema it has not
migrated. The bookmark and the rewind are what make applying it on its own acceptable.

**90 days gives a tenant a quarter to move.** That is long enough to plan a move, and short enough
that a publisher does not carry old majors indefinitely.

## Not decided here

- What happens to an install still on an old major at its end date: whether the platform moves it,
  stops serving it, or asks again.
- A release within a major that asks for permissions the install did not consent to. The classifier
  ranks any permission change at least minor, and flags it for the permission checkpoint. Whether an
  installing tenant approves it before it applies is a separate decision.

## Not built

A serving script per major, a major's end date, the notice to an install, the refusal of a
breaking promote of a listed app, and `adopt-serving` between majors of one app. The badge, the
bookmark, `rewindScope`, the listed reconcile and the classifier are built.
