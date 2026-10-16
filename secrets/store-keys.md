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
   then deploy the control plane. Every store script uploaded from now on carries them (a script
   uploaded earlier gets them only on its next upload, #2309).
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
one key used for both audiences. `--key-file` adds a staged key from `generate` to the check.
A failure names the variable and the check, never a value.

`doctor` reads the env file. It cannot see what is deployed: a set that passes here is the set
`push` would install.

## Rotation

`pnpm store-keys rotate --audience <caller|platform> --env <env> [--key-file <staged>]` prints
these steps with the current one marked. It refuses when the set fails `doctor`.

1. **Generate** the new pair to a file outside the work tree (`--out`). Keep the file.
2. **List** the new public key after the current one in its `…_PUBLIC_KEYS`,
   `node scripts/secrets.mjs push --env <env> --only control-plane`, and deploy the control plane.
   Check: `doctor --key-file <file>` shows the staged key listed.
3. **Wait** until every store script the signer calls carries the new list (see the limit below).
4. **Switch the signer.** Replace the `STORE_…_KEY=` line with the staged file's line, push
   `--only router` (caller) or `--only control-plane` (platform), deploy that worker, and delete
   the staged file. `doctor` refuses a signer whose key is not listed, which is the ordering that
   would break every call for that audience.
5. **Drop** the old key: `rotate --audience <aud> --drop <old kid>` prints the new list value. It
   refuses to drop the key the signer uses, and a kid that is not listed. Paste it, push
   `--only control-plane` and deploy the control plane.

### The limit: a list reaches a store script only when that script is uploaded

The control plane writes the lists into a store script when it uploads it. Today that happens
on the owning vertical's next push or serve. Nothing re-uploads the whole fleet when a list
changes; that is issue #2309. Until it is built:

- step 3 lasts until every vertical with a store has been pushed or served again, and nothing
  reports when that has happened;
- a dropped or revoked key is still accepted by every store script uploaded before the drop,
  until that script's next upload.

## A leaked private key

The order is the reverse of a planned rotation, because the old key must stop signing first:

1. Generate a new pair (step 1) and list the new public key (step 2).
2. Switch the signer to it at once (step 4), without waiting for step 3. Calls for that audience
   fail at any store script that does not yet carry the new list. That is the cost of revoking.
3. Revoke the old private key at the secrets manager: replace it in the password-manager copy,
   and make sure no other copy of the old line survives (files, shell history, scrollback).
4. Drop the old public key (step 5) and deploy the control plane.

Dropping the public key while the old key still signs would refuse the platform's own calls
wherever the new list arrives. Even done in this order, the compromised key stays accepted by
each store script until that script is uploaded again (#2309).

A leaked key signs only for its own audience, and for every store script and object of it: the
envelope names the script and object, and the key does not limit either. A leaked `caller` key
can send any store driver operation to any store, but never a reserved `substrat.*` operation. A
leaked `platform` key can send the reserved operations, `substrat.erase` and `substrat.wipe`
included, to any store. Both are emergencies.

## What the tool does not do

- It never prints a private key anywhere but the one place `generate` was told to put it.
- It never writes inside a git work tree, never edits the env file, and never overwrites a file.
- It never talks to Cloudflare. It does not push secrets, deploy a worker, upload a store script
  or re-upload the fleet; `scripts/secrets.mjs` and the deploys do those, and the fleet
  re-upload does not exist yet (#2309).
- It cannot see what is deployed, so it cannot tell you a rotation's step 3 is finished.
