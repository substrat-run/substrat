---
status: building
layer: plan
description: The platform's sign-in relay (id.substrat.net) becomes the hop an Auth Server install's BankID calls leave through. The install sends the tenant's certificate with each call and keeps it under its own console; the relay opens the socket, runs rustls (WASM) with it and stores nothing. Needed because a dispatched vertical has neither a client-certificate fetch nor a socket.
---

# RFC: BankID's client certificate, presented by the sign-in relay

**Status:** building — the hop, the install's transport and the connection test are built; encryption at rest is open (§5). **Extends:** [apps/social-relay](../../apps/social-relay/src/routes.ts)
(#1544), which today is an OpenID Provider per upstream with no UI. **Evidence:**
[spikes/mtls-wasm](../../spikes/mtls-wasm/FINDINGS.md). **First and only consumer:**
`demos/auth-server`'s BankID sign-in.

## 1. Problem

BankID's relying-party API authenticates the caller by a **client certificate** presented in
the TLS handshake. Each tenant is issued its own by its bank, under its own name — the name the
BankID app shows the person signing in — so the certificate is the tenant's, not the platform's.

An Auth Server install stores that certificate from its console and its hosted instances can
never present it, by any route a Worker has:

| route | why it fails |
|---|---|
| `fetch` | Takes no client certificate. |
| `node:https` / `node:tls` | `key`/`cert`/`pfx` are documented as unsupported in `node:https`; `node:tls` accepts them and silently ignores them ([workerd#7201](https://github.com/cloudflare/workerd/issues/7201)). |
| an `mtls_certificate` binding | Fixed at deploy time, one per script, and refused for a pushed vertical ([self-serve-deploy.md](../architecture/self-serve-deploy.md) §4.1). One script serves every tenant that installed the vertical, so it is the wrong shape anyway. |
| raw TCP (`cloudflare:sockets`) plus TLS of our own | Works in a Worker (§2), but **every dispatched script has `connect()` disabled**: the router attaches the [D-46](../decisions/D-046-a-hosted-vertical-s-outbound-egress-is-a-declared-per-versio.md) outbound worker, and Cloudflare turns sockets off for a script that has one. D-46 relies on that. |

So `publicBankIdFrom` parks BankID on every hosted instance (it waits for an `mtls_certificate`
binding no hosted instance can have) while the console says "Enabled", and the certificate and
key sit in the install's `config` table as plain JSON.

## 2. What the spike established

[spikes/mtls-wasm](../../spikes/mtls-wasm/FINDINGS.md): rustls 0.23 (ring provider), compiled to
`wasm32-unknown-unknown`, driven over a `cloudflare:sockets` connection opened with
`secureTransport: 'off'`. ~90 lines of Rust move bytes between the socket and rustls; there is no
cryptography of our own. Against BankID's test API with BankID's published test certificate, in
local workerd:

```
tls.config      35 ms
tcp.open       117 ms
tls.handshake  215 ms  TLSv1_3
http.response  289 ms  400 {"errorCode":"invalidParameters","details":"Invalid orderRef"}
```

A `400 invalidParameters` for `/collect` of an all-zero `orderRef` means the handshake and the
certificate were accepted (without a certificate BankID's front answers `403`). A wrong root fails
in its own stage: `tls: invalid peer certificate: UnknownIssuer`. BankID's servers chain to
BankID's own roots, which no public trust store holds; rustls is handed exactly those. The module
is 494 KB, 204 KB gzipped.

**Not yet established:** the same on Cloudflare's edge rather than local workerd (§8, step 1).

## 3. Decision in one paragraph

The sign-in relay at `id.substrat.net` gains one route, `POST /mtls/bankid/{environment}{path}`,
and becomes the place an install's BankID calls leave the platform. The relay is a standalone
worker, not a dispatched script, so it may open a socket. It authenticates the caller with the
**install's own relay client credential** — the one the platform already issues each install for
platform-provided social sign-in — opens a TCP connection to BankID's API host for that
environment, runs rustls presenting **the certificate and key the install sent with the call**,
and returns BankID's status and body with the stages it took. The relay keeps nothing once the
call ends. Everything BankID means stays in the install: the certificate and its management in
the install's console, the UI, the orders, the animated QR, `collect` polling, the sign-in
itself. The relay is a hop, with no BankID logic beyond which two hosts and which path prefix it
will reach.

## 4. Why the relay, and why a hop

**The relay already has the two things the other routes lacked.** It may open sockets, being
outside the dispatch namespace. And it already knows each install individually: the
social-relay reconciler (#1544) registers every Auth Server install as its own client, delivers
the client id and secret through `/internal/configure`, and keeps a per-install kill switch. A
call made with that credential is proven to come from that install, including from inside the
install's Durable Object, where Better Auth and the BankID plugin run. Nothing has to be stamped
by the egress worker, which a DO-originated `fetch` never passes through.

**A hop, not a BankID provider.** The relay could instead offer BankID as an upstream OIDC
provider, like `/github`. That would put a UI in a worker that deliberately has none (the QR, the
same-device button, the polling), move the sign-in's state into it, and make the relay the
relying party in the flow. Keeping the relay a transport keeps it what it is today: no screens,
no sessions, no accounts, and no tenant secrets.

**Rejected alternatives:**

- **A first-party `mtls` connector in the control plane, called through the proven-caller relay.**
  Correct and more general, but it needs a synchronous connector path that does not exist and a
  proven caller from a Durable Object, which the platform cannot give today. Kept as the shape
  for a vertical that calls a client-certificate API itself (§9).
- **Sockets for the auth-server's own worker,** by exempting it from the outbound worker or by
  extending D-46 to declared socket destinations. Reopens the channel D-46 counts as closed.
- **The relay storing the certificates,** sealed per install client. It would keep the key out of
  the install's database, but move a tenant's credential out from under the console that manages
  it, give the relay tenant secrets for the first time, and split one setting across two places.
  The certificate is per tenant and the tenant manages it in its own install, so it lives there.
- **A container running Node's TLS.** Works, at a container's cold start and running cost on a
  sign-in path. The fallback if §8 step 1 fails.

## 5. The certificate

**Held by the install, managed from its console, sent with each call.** BankID issues the
certificate to the tenant, and the tenant manages it where it manages the rest of its sign-in:
the install's BankID page. Nothing about that changes, except how the key is kept and how it
leaves.

- **Encrypted at rest — open.** Today the certificate and key are one plain JSON row in the
  install's `config` table, redacted from introspection but carried by the dump and the export.
  The intent is to encrypt the key under a secret that is *not* in the scope. On a standalone
  deploy that is an env secret of the worker. On a hosted install it is not: a hosted install's
  declared env values are delivered by the platform into that same `config` table
  (`deliveredConfig`, `cfg:<key>` rows), and a pushed vertical has no script-level secret of its
  own, so a key "from the environment" would sit beside the ciphertext it unlocks. Encrypting
  there needs a secret the platform holds per install outside the scope — its own decision, not
  this slice's. Until then the row is as it was, and nothing in this RFC makes it worse: the key
  was already in the scope, and it now additionally travels per call to a relay that keeps nothing.
- **Decrypted for one call.** The install's transport reads the key, sends it in the hop's body
  over TLS to the relay, and drops it. The relay holds it for the length of that call's handshake
  and keeps nothing: no store, no cache, no log.
- **Tested on save.** Saving a new certificate, or a new environment for the stored one, runs the
  probe (§7) through the same transport a sign-in uses, and records the answer on the row. A key
  that does not match its certificate, a test certificate saved as production, or a relay that
  cannot be reached shows on the page at once, at the stage it failed. The row is saved either
  way — through the relay, BankID is simply not offered until a test passes — so a transient
  failure does not cost the operator what they pasted.
- **One per environment,** `test` and `production`, as at BankID and as the page has today.

The trade this accepts: the key crosses the network on every call — inside TLS, to a platform
worker that does not persist it. The relay never becomes a store of tenant credentials, and the
one place a tenant's certificate is managed is the one place it is kept.

## 6. The hop

```
POST https://id.substrat.net/mtls/bankid/{test|production}/rp/v6.0/{auth|collect|cancel|sign|…}
Authorization: Basic <relay client id : secret>
Content-Type: application/json

{
  "certPem": "-----BEGIN CERTIFICATE-----…",   // the chain may follow the leaf
  "keyPem":  "-----BEGIN PRIVATE KEY-----…",
  "caPem":   "-----BEGIN CERTIFICATE-----…",   // BankID's root, as the install pins it
  "body":    { …BankID's own request body… }
}
```

- **Reach.** The environment selects the host: `appapi2.test.bankid.com` or `appapi2.bankid.com`,
  port 443. The path must be `/rp/v6.0/<call>`. Both are fixed in relay code; the caller names
  neither a host nor a port.
- **Roots travel with the call.** The install already pins BankID's published roots
  (`BANKID_ROOT_CA`) and carries an override for the day BankID rotates them, so it sends the
  one it trusts as `caPem` and the relay trusts exactly that. A caller choosing its own root can
  only weaken its own connection, to a host it does not choose; keeping the roots in one place
  means a rotation is one change, not two.
- **The certificate is used, never kept.** Parsed for the one handshake and dropped with the
  connection. The relay refuses a body that is missing either half, and its log line never
  includes the body.
- **Shape.** `POST`, a JSON body up to a small bound, a response read up to a bound, no redirects
  followed, a deadline (`BANKID_TIMEOUT_MS`'s 15 s), one request per connection.
- **Answer.** `200` from the relay carrying `{ status, body, stages }` when BankID answered, whatever
  BankID's status was; the relay's own refusals (`401` bad client, `403` disabled client, `400` a
  certificate or key that does not parse, `502` a failure before BankID answered) are problem
  documents naming the stage. The install's transport turns that back into the `{ status, body }` its
  `BankIdTransport` already returns, so `bankid.ts` and the plugin do not change.
- **What it sees.** A `collect` answer carries the person's personal number and name. The relay
  forwards it and does not log, store or inspect any body. Its log line per call is the client id,
  the environment, the BankID path, the status and the stage timings.
- **Rate.** Per client, bounded well above BankID's two-second polling, so one install cannot
  exhaust the relay for the others.

## 7. Diagnostics

| stage | a failure here reads as |
|---|---|
| `client` | the relay credential is wrong, or the client is disabled |
| `certificate` | (in the install) no certificate saved for this environment, it has expired, or it cannot be decrypted |
| `tls.config` | the certificate or key does not parse, or they do not match |
| `tcp.open` | BankID's host is unreachable |
| `tls.handshake` | BankID's certificate is not under the expected roots, or BankID refused ours |
| `http.response` | BankID answered — its status, for the install to interpret |

The install's BankID page gets **Test connection**: the probe through the hop with the stored
certificate, showing these stages. The probe is BankID's `collect` for an all-zero `orderRef`,
expecting `400 invalidParameters`, which starts no order and needs no person. `publicBankIdFrom`
offers BankID when a certificate is saved for the configured environment and its last probe
passed; otherwise the page says which stage failed, instead of "Enabled".

## 8. The first slice

1. **Confirm §2 on the edge.** The spike worker deployed standalone on Cloudflare, same probe. If
   it fails, stop: the container is the fallback and this RFC changes shape.
2. **The transport in the relay.** The rustls crate (`apps/social-relay/mtls-wasm/`) and its driver
   (`src/mtls-client.ts`, `src/mtls-socket.ts`). The module is built by `tools/mtls-wasm-emit.mjs`
   inside a digest-pinned image as linux/amd64, and committed with the generated-file marks; CI's
   `mtls-wasm` job rebuilds it from source and fails on one differing byte. Two builds produce the
   same sha256. `pnpm build` does not run it, so a checkout without Docker or Rust still builds.
3. **The route.** The hop, behind client authentication and the kill switch, with the per-client
   rate. No storage.
4. **The install.** A `BankIdTransport` over the hop (`src/bankid-transport-hop.ts`), chosen when
   the install holds a relay client and no `mtls_certificate` binding; the probe on save and Test
   connection on the BankID page, with the stages; `publicBankIdFrom` offering BankID through the
   hop only once a test has passed. Encryption at rest waits on §5.
5. **auth.substrat.net.** Its relay client is still the hand-registered one until the #1544
   backfill runs. The hop works with either, since the certificate does not live at the relay.

## 9. What this does not do

- **No sockets for verticals,** and no change to D-46.
- **No BankID logic in the relay**, no UI, and no stored tenant credential.
- **No general mTLS for verticals.** A vertical that itself calls a client-certificate API —
  Swish, a bank — is not served by a hop that knows BankID's two hosts. The shape for that is a
  first-party connector in the control plane with targets the vertical declares, called
  synchronously from host code by a proven caller; it waits for its first consumer. If the hop's
  targets are ever widened instead, they become declarations reviewed like D-46's `outbound`
  hosts, never a host the caller names.

## 10. Decided

1. **The certificate stays with the install and travels with each call** (§5). The relay stores no
   tenant credential.
2. **The hop is BankID-only in code**, not a target list: a list with one entry is a configuration
   surface nobody reviews.
3. **The rustls crate is built from source in CI**, never trusted as a checked-in binary: the
   module is committed for a checkout without Docker, and CI rebuilds it in the pinned image and
   refuses a difference (§8, step 2).
