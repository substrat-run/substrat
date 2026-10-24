# Scope-store envelope keys — runbook

Every call to a scope store carries an envelope signed with Ed25519
([K-52](../docs/decisions/K-052-the-scope-store-envelope-is-ed25519-per-audience-and-an-object-is-bound-to-its-name-by-its-id.md),
[RFC scope-stores §10.3](../docs/rfc/scope-stores.md)). This page covers making those keys,
storing them, putting them in place, checking them, rotating them, and what to do when one
leaks. The tool is `pnpm store-keys` (`tools/store-keys.mts`).

> **Status.** K-52 is *proposed*, not ratified. What this page describes is the code on `main`:
> the envelope module, the router's and the control plane's signers, and the store entry. If
> K-52 changes before it is ratified, this page changes with it. The rename of the store
> concept to *store driver* (K-53, #2324) changed wording only. The variables below and the store
> script's own bindings (`SUBSTRAT_STORE_CALLER_KEYS`, `SUBSTRAT_STORE_PLATFORM_KEYS`,
> `SUBSTRAT_STORE_*`) keep their names.

## The four values

| Env file key | What it is | Secret | Held by |
|---|---|---|---|
| `STORE_CALLER_KEY` | The `caller` private key: Ed25519 in the 48-byte PKCS8 v1 form, base64url | **yes** | the router alone |
| `STORE_PLATFORM_KEY` | The `platform` private key, same format | **yes** | the control plane alone |
| `STORE_CALLER_PUBLIC_KEYS` | The `caller` public keys: raw 32-byte Ed25519, base64url, comma-separated | no | the control plane, which writes it into every store script |
| `STORE_PLATFORM_PUBLIC_KEYS` | The `platform` public keys, same format | no | the same |

The router signs every call a vertical makes to its own store (`caller`). The control plane
signs the reserved `substrat.*` operations: export, import, size, wipe and erase (`platform`).
A store script verifies against the list for the envelope's audience and holds no private key.

The rules the store enforces, and `doctor` checks before a deploy does:

- one key per audience; the same key may never sign for both;
- a key in **both** lists makes every store refuse every call (its holder could sign `substrat.erase` with the `caller` key);
- a small-order point, a key that is not 32 bytes, a non-canonical spelling (base64url whose unused trailing bits are set, so a second text names the same bytes), and a key listed twice are all refused;
- a private key must be exactly the 48-byte PKCS8 v1 form `generate` writes. A DER parser may
  accept trailing bytes, or another encoding of the same seed, and derive the same kid, and
  runtimes differ on that. The envelope module checks the form itself before any parser sees the
  key, so `doctor`, the router and the control plane refuse the same values;
- a key id (*kid*) is base64url of the first 8 bytes of SHA-256 over the raw public key. A signer whose kid is not in its audience's list is refused on every call.

## Where the private keys live

In the deployment's secrets manager, on the one worker that signs with each, and, while you work,
in the gitignored env file. The source of truth is the password-manager
copy of `secrets/platform.<env>.env` (see [README.md](./README.md)). From there,
`node scripts/secrets.mjs push` puts each key on its one worker as a Cloudflare secret, and
Cloudflare never gives it back. Never in the repository, a commit, an issue, a PR, a chat or a log.

`generate` enforces its own part of this. It writes the private key only:

- to a **new** file you name with `--out`, created with mode 0600. It refuses a path inside
  this repository or any git work tree (judged on the resolved directory, so a symlink into one
  is refused too), a directory its group can write or other users can reach at all
  (0750 and 0700 pass), an existing file, and a file that
  came out readable by anyone else; or
- to stdout with `--stdout`, which it refuses while stdout is a terminal unless you also pass
  `--yes-print-to-terminal`.

You then paste that one `STORE_…_KEY=…` line into the env file by hand, and delete the file
`generate` wrote. The env file is inside the work tree (gitignored), which is exactly why the
tool will not write there.

## First provisioning

Public keys go out before private keys, so no signer is ever live with a key a store does not
know. That takes two pushes, in this order.

1. For each audience, generate a pair:
   `pnpm store-keys generate --audience caller --out ~/keys/store-caller.key`
   and the same for `platform`. Stderr shows each public key and its kid.
2. Put **only** the two public keys in the env file:
   `STORE_CALLER_PUBLIC_KEYS=<caller public key>`, `STORE_PLATFORM_PUBLIC_KEYS=<platform public key>`.
   Leave `STORE_CALLER_KEY=` and `STORE_PLATFORM_KEY=` blank for now.
   `pnpm store-keys doctor --env <env> --key-file ~/keys/store-caller.key --key-file ~/keys/store-platform.key`
   reports the two private keys as unset, which is expected here, and must report nothing else.
3. Push and deploy the lists: `node scripts/secrets.mjs push --env <env> --only control-plane`,
   then deploy the control plane. Every store script uploaded from now on carries them, and the
   control plane rebuilds the ones uploaded earlier (see [the fleet rebuild](#the-fleet-rebuild)).
4. Paste each generated line in as `STORE_CALLER_KEY=` / `STORE_PLATFORM_KEY=`, then delete
   the generated files. `pnpm store-keys doctor --env <env>` must now print `✓ ok`.
5. Push and deploy the signers: `node scripts/secrets.mjs push --env <env>`, then deploy the
   router and the control plane.

Until a store driver is served, all four are optional and an unset key simply refuses store calls.

## Checking a configured set

```sh
pnpm store-keys doctor --env prod                       # secrets/platform.prod.env
pnpm store-keys doctor --file <env file> --key-file ~/keys/new.key
```

It prints each audience's listed kids and public keys, marks which one the signer uses, and
names the rotation phase. It exits 1 on any problem: an unset or malformed list, a bad entry
(named by position, never by value), a duplicate or alias, a key in both lists, an unset or
unusable private key, a signer whose key is not in its own list or *is* in the other list, and
one key used for both audiences. It also refuses a list holding a value that looks like private
material (an error, so `rotate` refuses too). Paste a list's entries only from the tool's own
output (`generate`, `rotate`): it cannot recognise private material in every encoding.
`--key-file` adds a staged key from `generate` to the check. A failure names the variable and the
check, never a value.

`doctor` reads the env file. It cannot see what is deployed: a set that passes here is the set
`push` would install.

## Rotation

`pnpm store-keys rotate --audience <caller|platform> --env <env> [--key-file <staged>]` prints
these steps with the current one marked. It refuses when the set fails `doctor`.

1. **Generate** the new pair to a file outside the work tree (`--out`). Keep the file.
2. **List** the new public key after the current one in its `…_PUBLIC_KEYS`,
   `node scripts/secrets.mjs push --env <env> --only control-plane`, and deploy the control plane.
   Check: `doctor --key-file <file>` shows the staged key listed.
3. **Wait** until every store script carries the new list: `substrat store-driver status --driver <driver>`
   reads `scripts: current` for every registered driver ([the fleet rebuild](#the-fleet-rebuild)).
4. **Switch the signer.** Replace the `STORE_…_KEY=` line with the staged file's line, push
   `--only router` (caller) or `--only control-plane` (platform), deploy that worker, and delete
   the staged file. `doctor` refuses a signer whose key is not listed, which is the ordering that
   would break every call for that audience.
5. **Drop** the old key: `rotate --audience <aud> --drop <old kid>` prints the new list value. It
   refuses to drop the key the signer uses, and a kid that is not listed. Paste it, push
   `--only control-plane` and deploy the control plane. The old key is revoked only when
   `store-driver status` reads `scripts: current` for every driver **and** no control-plane deploy is
   still rolling out: until then a script listed as pending or settling, or one a control plane still
   serving the older lists uploads, accepts the old key. Once the deploy serves only the new version,
   force a walk of every script with
   `substrat store-driver rebuild --driver <driver> --deploy-finished` for each driver, repeated
   until each reads `scripts: current`.

### The fleet rebuild

The control plane writes the lists into a store script when it uploads it. A push, a serve and a
rollout upload the scripts they reach. The rest are rebuilt by the control plane itself (#2309):

- **What starts it.** What the platform builds a store script from (both key lists, the store entry,
  its verifier and the compatibility flags) is one digest, the *fingerprint*. Deploying the control
  plane with a changed list changes it. Each driver's rebuild converges every script on the
  fingerprint the running control plane computes, and starts over when that changes.
- **What it does.** It rebuilds each existing script at the release it already runs; it never moves a
  script to another release and never creates one. A script already built from the fingerprint is
  read and left alone. It takes the shared hold a push takes, so it waits while a rollout or
  rollback holds the driver, and a rollout that paused, or a rollback that has not finished, keeps
  its scripts where they are.
- **When it runs.** On the control plane's quarter-hourly scheduled pass. A pass spends at most
  `STORE_REBUILD_SUBREQUESTS` subrequests (default 500, half an invocation's 1000; 5 a script), so it
  walks 100 scripts, the driver's canary first, then each vertical in slug order. It records where it
  stopped, and the next pass continues there. `STORE_REBUILD_SUBREQUESTS=0` pauses it.
- **Run it now.** `substrat store-driver rebuild --driver <driver>` runs a pass at once, for one
  driver, as a person (a staff sign-in, never the service token). It is audited as
  `rebuildStoreDriver`, takes the same lease as the scheduled pass (so the two never walk a driver at
  once), and walks up to 180 scripts. A driver whose walk is done is walked again (reads only, and an
  upload for a script that is not current). It answers `paused` while scripts remain: run it again.
- **How long.** For N scripts of one driver (its verticals plus its canary), the scheduled pass alone
  needs ⌈N / 100⌉ passes: 1,000 verticals take 11 passes, about 2¾ hours, on top of the wait for the
  first pass. Running `store-driver rebuild` back to back takes ⌈N / 180⌉ runs, 6 for 1,000
  verticals, each as long as its uploads (a few minutes at most). With several drivers, the
  scheduled pass shares its budget across them in registration order.
- **Where to watch.** `substrat store-driver status --driver <driver>` ends with `scripts: current`,
  `scripts: settling` (see the next point), or `scripts: NOT current` with the scripts that may still
  be on the old build (`-canary` is the driver's canary script) and each failure. It never reads
  `current` while a script could not be rebuilt or checked. A vertical whose versions' stores cannot
  be named is walked by its script's name, which depends only on the vertical and the driver, so it
  is a failure only if that script exists and cannot be rebuilt.
- **A failure that persists.** Each `failed:` line is retried on every pass, and is also an
  ops-failure row (`store-rebuild`), so it reaches the failure digest. Until it clears, the driver
  is not current, and the old key is not revoked at that script. What to do:
  - `upload failed (5xx)`, or the runtime refusing for a moment: nothing. The next pass retries it.
    Run `store-driver rebuild` to retry at once.
  - `records no release`: the script was not uploaded by the platform. Find out who uploaded it
    before anything else.
  - `release … is not pinned` or `is not stored`: the script runs a release the registration no
    longer pins. Roll out a pinned release of the driver (`store-driver rollout`), which moves the
    script and rebuilds it.
  - Anything else, or a failure that outlives a day: raise it with the platform's staff on call,
    with the failure line and the driver. Until it is cleared, treat the old key as still accepted
    by that one script. If the key leaked, that script's vertical is exposed.
- **During a deploy.** While two control-plane versions run side by side with different lists, a push
  served by the older one uploads its script with the older lists, even after the walk is done. So
  only a walk that **began** at least the settle window after its lists first appeared proves every
  script current: a walk that spans passes reads its first scripts when it begins. A done walk that
  began inside the window reads `scripts: settling` with the time it is walked again, and the
  scheduled pass walks it again from its first script then (reading each script, uploading only one
  that is not current). The window is `STORE_REBUILD_SETTLE_MINUTES` on the control plane (60 by
  default): set it to how long a deploy of the control plane takes to serve only the new version.
  `store-driver status` prints when the lists were first walked towards and when the next automatic
  walk is, so a `settling` line says why it is not `current` yet.
- **Attesting the deploy finished.** `substrat store-driver rebuild --driver <driver> --deploy-finished`
  is a person saying no control-plane deploy is rolling out. That run starts the walk over from its
  first script, and once that walk is done it proves every script current without waiting out the
  window. Repeating it continues the attested walk under way rather than starting it over, so a fleet
  larger than one run (180 scripts) finishes by repeating it until it reads `scripts: current`. It is recorded in the admin log with the person, and status names who attested. Use it
  only when the deploy that changed the lists serves the new version alone (the deploy is finished,
  not part way through a gradual rollout); otherwise wait for the window, or run `store-driver
  rebuild` without it and let the window run.
- **Re-verifying.** A `done` walk is walked again a day after it finished, and `store-driver rebuild`
  always walks again. While such a re-walk at lists an earlier walk already proved is under way,
  status reads `scripts: current (re-verifying …)`; it reads `NOT current` only once a script that
  walk reaches fails, or the lists change.

## A leaked private key

The order is the reverse of a planned rotation, because the old key must stop signing first:

1. Generate a new pair (step 1) and list the new public key (step 2).
2. Switch the signer to it at once (step 4), without waiting for step 3. Calls for that audience
   fail at any store script that does not yet carry the new list. That is the cost of revoking.
   Run `substrat store-driver rebuild --driver <driver>` for every driver at once, so the new list
   reaches every script without waiting for the scheduled pass.
3. Revoke the old private key at the secrets manager: replace it in the password-manager copy,
   and make sure no other copy of the old line survives (files, shell history, scrollback).
4. Drop the old public key (step 5) and deploy the control plane.
5. Once that deploy serves only the new version, run
   `substrat store-driver rebuild --driver <driver> --deploy-finished` for every driver until each
   reads `scripts: current`. The old key is revoked only when status
   reads `scripts: current` **and** no control-plane deploy is still rolling out: a script listed as
   pending or settling still accepts it.

Dropping the public key while the old key still signs would refuse the platform's own calls
wherever the new list arrives.

A leaked key signs only for its own audience, and for every store script and object of it: the
envelope names the script and object, and the key does not limit either. A leaked `caller` key
can send any store driver operation to any store, but never a reserved `substrat.*` operation. A
leaked `platform` key can send the reserved operations, `substrat.erase` and `substrat.wipe`
included, to any store. Both are emergencies.

## What the tool does not do

- It never prints a private key anywhere but the one place `generate` was told to put it.
- It never writes inside a git work tree, never edits the env file, and never overwrites a file.
- It never talks to Cloudflare. It does not push secrets, deploy a worker, upload a store script
  or rebuild the fleet; `scripts/secrets.mjs`, the deploys and the control plane's rebuild do those.
- It cannot see what is deployed, so it cannot tell you a rotation's step 3 is finished:
  `substrat store-driver status` can.
