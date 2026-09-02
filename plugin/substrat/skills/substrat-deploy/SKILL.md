---
name: substrat-deploy
description: Deploy a Substrat vertical to production — substrat login, then substrat push --promote prod, and present the permission / migration checkpoints when a promotion is refused until they are acknowledged. Use when asked to deploy, ship, push, promote or release a Substrat vertical, or when a promotion was refused as an unacknowledged change.
---

# Deploy a Substrat vertical

`substrat push --promote prod` is the whole deploy: a private vertical's push lands
admitted, prod is the one serving channel, and it is self-serve. Everything interesting
here is the two moments the platform refuses to continue without a human.

**Read this first, because it is the reason this skill exists.** A promotion that changes
the permission surface or the migration surface is refused until `--ack-permissions` /
`--ack-migrations` is passed. Those flags are a *person's* acknowledgement. Your job is to
present the diff well enough that they can answer *who can now see the money, and who can
see other tenants' data?* — and then to stop. **Never pass an ack flag yourself, and never
instruct a subagent to.** The flag is mechanical precisely so that skipping the reading is
a deliberate act, not an accident; an agent that passes it has converted the platform's one
hard stop into a no-op.

## 1. Know what you are deploying

From the vertical's directory:

- `package.json`'s `substrat` block carries the slug, name and tenant. `substrat push`
  defaults all of them, so the command usually takes no flags at all.
- Run the project's own gates first — `npm test`, `npm run typecheck`,
  `npx @substrat-run/boundary-lint` — and read `AGENTS.md` if you have not. The push runs
  the layer rules on the source before it builds and refuses on a violation, so a red gate
  here is a failed deploy a minute later.
- Say which tenant and which vertical you are about to push to, and confirm it, before the
  first authenticated call. A first push of a slug **claims** it for a workspace.

## 2. Sign in

```sh
substrat login          # browser, per-human
substrat whoami         # who you are + which workspaces
```

`substrat login --token <serviceToken>` stores a machine credential and is for CI, not for
a person at a terminal. If `SUBSTRAT_SERVICE_TOKEN` is set in the environment it shadows a
browser session — the CLI warns; do not ignore the warning, because it means the deploy is
being made by an actor other than the one who is reading this.

## 3. Try it against real data first, when there is any

If the vertical already serves production scopes and this change is not trivial:

```sh
substrat preview create --tag <tag>
```

That pushes this tree and runs it against a **fork** of prod on its own `--<tag>` URL, with
a TTL. Dev and staging channels were retired; a preview against forked data is what
replaced them. `substrat preview delete --tag <tag>` reaps it.

## 4. Push, and promote

```sh
substrat push --promote prod
```

One command deploys when nothing needs acknowledging. When something does, the promotion —
not the push — is what is refused, and the message names two digests:

```
promotion changes the permission surface (<old> → <new>) — acknowledge it explicitly to promote
promotion changes migrations (<old> → <new>) — acknowledge it explicitly to promote
```

A digest is not a diff. Producing the diff is step 5.

## 5. Present the checkpoint, then stop

The platform tells you *that* the surface moved. Only the repository can say *how*, so
build the diff from the source and show it in full.

**Permission diff** — a table, in the reviewer's vocabulary, not the code's:

| Permission key | What it lets someone do | Which roles hold it | New? |
|---|---|---|---|

Read it out of the vertical's provisioning surface (`ROLES` and the permission registry —
in a scaffolded project, `src/provision.ts`) and compare against what is deployed. Call out
by name: any key that is new, any role that gained one, and anything that widens what a
role can see across customers or across money. A permission diff nobody understands is
theater — it reproduces the exact failure Substrat exists to prevent.

**Migration diff** — every new `SqlMigration`, verbatim, in order, with its version. Say
plainly what each does to existing rows, and that migrations are append-only forever once
shipped, so this is the last cheap moment to change your mind.

Then **stop and hand it over**. Give the exact command for them to run, and let them run
it:

```sh
substrat promote <slug> --version <versionId> --ack-permissions   # and/or --ack-migrations
```

If they reply "yes, go ahead" without having read the diff you printed, that is not an
approval — ask them to confirm the specific line that matters (the widened role, or the
migration that rewrites rows). One ask, not an argument.

## 6. Verify it actually shipped

A command that exited 0 is not a deployment. Check that the serving channel really moved:

```sh
substrat versions <slug>     # which version prod points at now
substrat installs <slug>     # directory status + served hostname
```

Then load the served hostname. Report the version id and the URL — not "deployed" on its
own. A push that produced no new version, or a promotion that was refused and never
re-run, both exit quietly enough to look like success; the channel is the only thing that
settles it.

## Two situations that are not this flow

- **A listed vertical.** Once a vertical is listed on the public marketplace its pushes
  land pending and prod promotion is a staff decision again. `--promote prod` will not
  complete it. Say so rather than retrying.
- **CI.** `substrat init --ci github` writes the workflow that deploys prod on merge and
  gives every PR a preview URL. If the user wants deploys to stop being something a person
  runs, that is the answer — and the ack checkpoints still apply there, which is why the
  workflow does not carry the flags either.
