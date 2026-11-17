# @substrat-run/control-plane

The **shared control-plane deployment** — the directory-side control plane
(control-plane.md §4) as one deployable Cloudflare Worker. Slice 1 of
[the first end-to-end flow](../../docs/briefs/first-flow.md).

A singleton `ControlPlaneDO` (tenant registry, scope lifecycle, entitlements,
roles, admin audit log) fronted by the audited `createControlPlaneApi` router.
This is the one deployment the whole platform shares: verticals register their
tenant/scope here, and the console reads and acts through it. Nothing
domain-shaped runs here — the module-less `ScopeDO` binding exists only because
the coordinator's `provisionScope` still instantiates one (see `src/worker.ts`;
decoupling that is slice 4).

Private, never published — it is a deployment, not a package.

## Run it

```
pnpm --filter @substrat-run/control-plane dev       # wrangler dev, no account; ALLOW_DEV_ACTOR on
pnpm --filter @substrat-run/control-plane test      # workerd test (the slice-1 DoD)
pnpm --filter @substrat-run/control-plane deploy     # needs a Workers Paid plan (DO SQLite)
```

Against `dev`, the UNSAFE `x-platform-actor` header is trusted:

```
curl -s -H 'x-platform-actor: 01JZ0000000000000000000001' http://127.0.0.1:8787/tenants
```

## Auth posture

Secure by default: a real `wrangler deploy` sets no `ALLOW_DEV_ACTOR`, so every
request **fails closed (401)** until real platform-staff auth lands (slice 3).

## Staff access

Who may act on the control plane lives in the `staff_actor` table in D1
(`migrations/0002_staff_roster.sql`), **not** in configuration. One
`PlatformActorId` per human, so the admin log can name who suspended a tenant;
before this every operator shared one hardcoded actor and the trail could not
tell them apart.

**The managed surface is the console's Members view** (`/api/members*` on this
worker, staff-session gated): grant and revoke for the staff roster. Grants made
there record the acting staff member (`added_by`,
`migrations/0003_staff_added_by.sql`), a re-granted member keeps their actor, and
revoking the last active staff member is refused. (Builder-studio access is NOT a
roster here: it is the `builder` entitlement on the tenant, granted in the console
like any SKU and read by the studio via the identity-tenants lookup.) The raw
statements below remain the bootstrap/recovery path:

```sh
# grant access
wrangler d1 execute substrat-control-plane-auth --command \
  "INSERT INTO staff_actor (email, actor, name, added_at)
   VALUES ('someone@substrat.run', '<new ULID>', 'Someone', datetime('now'))"

# revoke it — a tombstone, never a DELETE (K-21): the row is the evidence that
# access was once granted, which is what an audit asks for
wrangler d1 execute substrat-control-plane-auth --command \
  "UPDATE staff_actor SET revoked_at = datetime('now') WHERE email = 'someone@substrat.run'"
```

Mint the actor with any ULID generator; it is that person's identity in the audit
log forever, so it must never be reused or changed.

An empty roster means nobody can act — fail-closed is the correct posture, and
recovery is the grant statement above (which is why the console refuses to revoke
the final member: recovery must never be the only path).

**The roster also gates account creation.** Better Auth's sign-up endpoint is
public by default and is mounted on this origin, so before #47 anyone reaching
the control plane could create an account in the staff store. Sign-up now refuses
any email that is not on the roster, and refuses revoked entries — so a departed
operator cannot simply re-register.

The order is therefore: grant first, then the operator signs up and sets their own
password. That keeps one gate instead of two, and avoids minting password hashes
out of band.

Still **not** addressed: this is email and password with no MFA and no SSO
(`minPasswordLength: 8`), on a surface that can suspend every tenant. That is
kernel open question 14 and wants its own decision — §6 says the action list
should settle it, and the action list is now real.
The dev-actor stub — which names a subject with cross-tenant reach — is mounted
only under `dev`/test, never in `wrangler.jsonc` (control-plane.md §6).

## Inbound mail: switching on Email Routing (#2611)

The control plane receives mail for scopes' mail-in addresses through its `email()` handler. The
code is deployed with every release; **receiving starts only once an operator does the steps
below by hand**. Nothing in this repo changes DNS or routing rules, and nothing should: wrangler's
`addresses` key is top-level and would claim the rule for both environments.

| | Production | Test |
|---|---|---|
| Receiving domain (`MAIL_IN_DOMAIN`) | `in.substrat.run` | `in-test.substrat.run` |
| Worker the rule targets | `substrat-control-plane` | `substrat-control-plane-test` |
| R2 bucket (`MAIL_IN_BUCKET`) | `substrat-mail-in` | `substrat-mail-in-test` |

**The apex is not ours to touch.** `substrat.run`'s own MX points at another mail provider, and
Email Routing is switched on for the **subdomain only**. Cloudflare's docs say it adds the records
the subdomain needs; they do not promise to leave the apex alone, so the check in step 1 and step
6 is what holds that.

1. **Write down the apex MX** before anything else: `dig +short MX substrat.run`. Keep the output;
   step 6 compares against it.
2. **Create the bucket** if it does not exist (`wrangler r2 bucket list`):
   `wrangler r2 bucket create substrat-mail-in` (and `substrat-mail-in-test`). The control-plane
   deploy binds it, and with no bucket every message is refused.
3. **Add the subdomain.** Dashboard → Email Service → Email Routing → the `substrat.run` zone →
   Settings → Subdomains → add `in` (and `in-test`). If the dashboard offers to add or replace MX
   records **on the apex**, stop: decline, and ask before going on. Only records on the subdomain
   are expected.
4. **Turn on subaddressing** (Email Routing → Settings → Subaddressing). Every address the platform
   mints is `mail+<tag>@<domain>`, matched by one rule for `mail@<domain>`; without subaddressing
   none of them match.
5. **Add one routing rule** per environment: custom address `mail@in.substrat.run`, action *Send to
   a Worker*, target the worker in the table. A subdomain takes no catch-all rule (Cloudflare
   allows one on the apex only), which is why there is one literal rule rather than one per scope.
6. **Check the apex again**: `dig +short MX substrat.run` must print exactly what step 1 did. If it
   does not, remove the subdomain from Email Routing and restore the apex records from step 1.
7. **Check the subdomain**: `dig +short MX in.substrat.run` names Cloudflare's routing MX.
8. **Send a test.** Mail to `mail@in.substrat.run` itself bounces with *No such address* — that bounce
   is the worker answering, since a bare `mail@` is not a minted address. Then request an address
   for a test scope (`mailInAddress` from its worker, or the dashboard) and send to it: the worker's
   logs show `mail-in: received` and then `mail-in: delivered`.

**Turning it off** is removing the rule (mail then bounces at Cloudflare), or removing the subdomain
from Email Routing (no MX, so senders cannot deliver at all). Neither touches the apex. Mail already
accepted stays in the bucket and is delivered by the connector sweep; addresses keep their rows and
work again when the rule is back.

**Limits a sender meets** are set in code, not here: 25 MiB a message (Email Routing's own cap too),
and per address 60 messages an hour and 250 MiB a day (`MAIL_IN_MAX_*` in `@substrat-run/contracts`).
