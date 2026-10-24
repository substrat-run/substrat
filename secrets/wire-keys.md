# Wire envelope keys — runbook

The router and the control plane sign what they send a deployed vertical with Ed25519
([RFC wire-signing](../docs/rfc/wire-signing.md),
[K-58](../docs/decisions/K-058-a-call-from-the-platform-to-a-vertical-carries-an-ed25519-envelope-and-a-deployed-vertical-holds-public-keys-only.md)).
This page covers making those keys, storing them, giving deployments the public lists, turning
signing on and off, checking a set, rotating a key, and what to do when one leaks. The tool is `pnpm wire-keys` (`tools/wire-keys.mts`),
the scope-store key tool ([store-keys.md](./store-keys.md)) run over the wire's two issuers: every
check, refusal and rule about where a private key may be written is the same.

> **Status.** K-58 is *proposed*, not ratified. What this page describes is the code on `main`:
> the signers and the uploader (RFC §9, step 2, follow-ons 2 and 3). The control plane gives a
> deployment the public lists only where `WIRE_KEYS_ROLLOUT` names it, at its next upload; until
> then a signer that is on sends envelopes that are carried and ignored. If K-58 changes before it
> is ratified, this page changes with it.

## The seven values

| Env file key | What it is | Secret | Held by |
|---|---|---|---|
| `WIRE_ROUTER_KEY` | The `router` issuer's private key: Ed25519 in the 48-byte PKCS8 v1 form, base64url | **yes** | the router alone |
| `WIRE_PLATFORM_KEY` | The `platform` issuer's private key, same format | **yes** | the control plane alone |
| `WIRE_ROUTER_PUBLIC_KEYS` | The `router` public keys: raw 32-byte Ed25519, base64url, comma-separated, the key in use and a standby | no | the control plane, which uploads deployments |
| `WIRE_PLATFORM_PUBLIC_KEYS` | The `platform` public keys, same format | no | the same |
| `WIRE_ROUTER_SIGN` | The router's `sign` flag (its `WIRE_SIGN`) | no | the router |
| `WIRE_PLATFORM_SIGN` | The control plane's `sign` flag (its `WIRE_SIGN`) | no | the control plane |
| `WIRE_KEYS_ROLLOUT` | Which deployments an upload gives the two public lists to: `off`, `canary:<vertical>` or `fleet` | no | the control plane |

These are their own pairs, never the store keys (RFC Q1): a leaked key then opens one channel, and
each can rotate without the other. A key listed for both issuers is refused wherever the lists are
loaded, so the router's key can never sign as the platform. Every other rule is the store's
([store-keys.md](./store-keys.md#the-four-values)).

A `sign` flag is on only when the worker's setting is exactly `on`; unset, empty and anything else
is off. Off is the default, and off means the signer sends exactly what it sent before signing
existed. A blank line in the env file is not the same as off once a value has been pushed: see
[Turning signing off](#turning-signing-off).

## The standby key

Each list carries, beside the key in use, a **standby** public key whose private half is held
offline (RFC §6). It is in every deployment's list before any environment may go `signed-only`, so
a signer whose key leaks, or that cannot sign, switches to the standby at once and nothing is
refused. `doctor` warns while a list holds no standby beside the signer's key.

Keep the standby's generated file offline, in the password manager, and never on a worker until it
is needed.

## First provisioning

Public keys go out before private keys, and signing goes on last. Test environment first.

1. Generate four pairs, each to its own file outside any work tree:
   `pnpm wire-keys generate --issuer router --out ~/keys/wire-router.key`, then
   `~/keys/wire-router-standby.key`, and the same two for `--issuer platform`. Stderr shows each
   public key and kid.
2. Put **only** the public keys in the env file: `WIRE_ROUTER_PUBLIC_KEYS=<in use>,<standby>` and
   `WIRE_PLATFORM_PUBLIC_KEYS=<in use>,<standby>`. Leave both private keys blank.
   `pnpm wire-keys doctor --env <env> --key-file ~/keys/wire-router.key --key-file ~/keys/wire-platform.key`
   reports the two private keys as unset, which is expected here, and must report nothing else.
3. Push the lists: `node scripts/secrets.mjs push --env <env> --only control-plane`, and deploy the
   control plane. This gives no deployment anything yet: an upload gives the lists only to the
   deployments `WIRE_KEYS_ROLLOUT` names ([Giving deployments their lists](#giving-deployments-their-lists)).
4. Paste the two in-use lines in as `WIRE_ROUTER_KEY=` and `WIRE_PLATFORM_KEY=`, then delete those
   two files. Move the standby files to the password manager and delete them locally.
   `pnpm wire-keys doctor --env <env>` must now print `✓ ok`.
5. Push and deploy the signers: `node scripts/secrets.mjs push --env <env> --only router` and
   `--only control-plane`, then deploy both. They still sign nothing: their flags are off.
6. Turn signing on, one signer at a time: set `WIRE_ROUTER_SIGN=on`, push `--only router`, deploy the
   router; then `WIRE_PLATFORM_SIGN=on`, push `--only control-plane`, deploy the control plane.

**Check after step 6**, from the environment's Workers Logs: the router's `router: 'request'` lines
for dispatched requests carry `wire: 'signed'`, a peer invocation writes `router: 'wire-sign'` with
`outcome: 'signed'`, and the control plane writes `substrat: 'wire-sign'` lines with
`outcome: 'signed'`. Any `failed` names its reason (`unset`, a key-form refusal such as
`not-pkcs8-v1`, `claims`, or `error`), and the router also writes `router: 'wire-sign-failed'` to its error
log. A failed signature never fails a request: it goes with its legacy headers, as before. A
control-plane line with `outcome: 'skipped'` and `reason: 'stream'` is a streamed call left unsigned
by design (RFC §3.6), not a failure.

## Giving deployments their lists

The control plane gives a deployment the two lists, its own name and the state `dual` when it
uploads it (a version's push, or the serve a promote does), and only where `WIRE_KEYS_ROLLOUT` says:

| Value | Which deployments an upload gives the lists to |
|---|---|
| unset, or `off` | none |
| `canary:<vertical>` | that one vertical's: its versions' scripts and its serving script |
| `fleet` | every one |

Anything else gives none, and the control plane's error log says why (`substrat: 'wire-upload'`).
So do lists that would not load at a deployment: the upload checks them with the function the
entry loads them with, gives nothing, and names the problem, never a key. Every upload records
what it gave, or why it gave nothing, for the readiness report (RFC §7).

One canary first, in the test environment:

1. Set `WIRE_KEYS_ROLLOUT=canary:<vertical>`, naming one vertical by its registry slug. Push
   `--only control-plane` and deploy the control plane.
2. Upload that vertical: push a version and promote it, so its version's script and its serving
   script are both uploaded with the lists.
3. Check from the environment's Workers Logs: the entry's `substrat: 'wire'` lines for that
   vertical's requests read `signed-accepted` (once the signers are on) with no `reason` and no
   `fault`, and the control plane wrote no `wire-upload` line for it. Every other vertical's
   requests write no wire line at all: it was given no lists.
4. Then the fleet: set `WIRE_KEYS_ROLLOUT=fleet`, push and deploy the control plane. Each deployment
   is given the lists at its next upload; one no upload reaches keeps none, and serves as before.

Going back is writing `off` and pushing again: as with the flags, a blank line is skipped by `push`
and leaves the last value live. The next upload of each deployment takes its lists back; until then
it keeps them, which in `dual` changes nothing it serves.

## Turning signing off

Write an explicit value other than `on` into the signer's flag, `off` being the plain one
(`WIRE_ROUTER_SIGN=off` or `WIRE_PLATFORM_SIGN=off`), push that worker (`--only router` or
`--only control-plane`) and deploy it. **Blanking or removing the line does not turn it off:**
`secrets.mjs push` skips a blank key and never deletes a secret, so the worker keeps the `on` it was
last given. To remove the flag instead, delete the secret on the worker, from its directory
(`apps/router` or `apps/control-plane`): `pnpm exec wrangler secret delete WIRE_SIGN`, with
`--env <env>` outside prod. Then blank the line, so the next push does not put it back. Either way,
check the logs: the signer's `wire-sign` lines and the router's `wire` field stop, since none is
written while the flag is off. This is step 2's revert (RFC §9). Once any environment is `signed-only`, the signers' release gate refuses
it (RFC §7, follow-on 4); until then it is always safe, since nothing relies on a signature.

## Checking a configured set

```sh
pnpm wire-keys doctor --env prod                       # secrets/platform.prod.env
pnpm wire-keys doctor --file <env file> --key-file ~/keys/new.key
```

It prints each issuer's listed kids and public keys, marks which one the signer uses, and names
the rotation phase: `steady` is the key in use and its standby. It exits 1 on any problem the store
tool's `doctor` refuses, and warns when a list has no standby. A failure names the variable and the
check, never a value. `doctor` reads the env file; it cannot see what is deployed.

## Rotation

`pnpm wire-keys rotate --issuer <router|platform> --env <env> [--key-file <staged>]` prints the
steps with the current one marked. They are the store's: generate, list the new key beside the two
already listed, wait, switch the signer, drop the old key. The standby stays listed throughout:
`--drop` refuses to print a list that would hold only the signer's key, with no standby beside it,
unless `--without-standby` is passed.

The wait is the one difference. A list reaches a deployment only when the control plane uploads it
again (plain configuration is rewritten on every upload). Nothing yet reports which live
deployments carry a list: that is the readiness report (follow-on 4). Until it exists, a deployment
is known to carry a new list only once it has been uploaded since the list was pushed.

## A leaked private key, or a signer that cannot sign

The break-glass path (RFC §6), taken only by platform staff on call:

1. Switch the signer to the **standby** key at once: put the standby file's line in as the
   signer's private key, push that worker, deploy it. Every deployment already lists the standby,
   so nothing is refused.
2. Revoke the old private key at the secrets manager, and make sure no other copy of it survives.
3. Generate a new standby and list it, then drop the compromised public key
   (`pnpm wire-keys rotate --issuer <issuer> --drop <old kid>` prints the list without it; listing
   the new standby first is what lets `--drop` print it without `--without-standby`).
   Push and deploy the control plane.
4. Upload every live deployment again at once. A deployment not yet uploaded still accepts the
   compromised key.

## What the tool does not do

The store tool's limits apply unchanged ([store-keys.md](./store-keys.md#what-the-tool-does-not-do)):
it never prints a private key anywhere but the one place `generate` was told to put it, never
writes inside a git work tree, never edits the env file, and never talks to Cloudflare.
