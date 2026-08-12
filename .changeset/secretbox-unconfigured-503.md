---
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/dashboard": minor
"@substrat-run/dashboard-web": minor
---

fix: a plane with no seal key says so (503), instead of a bare 500 on every connect

Saving a Scrive credential against the deployed control plane returned `500` with no usable
detail. The cause was one line of deployment configuration: `SECRET_BOX_KEY` was unset, so the
host fell back to the unconfigured `SecretBox` and the connection store refused to write. The
refusal was **correct** — storing a credential unsealed is not an option — but it threw a plain
`Error`, which no seam recognised, so it collapsed into the generic 500 handler. The operator
saw what looked like a bug in the credential or the relay; only a worker tail (or `wrangler
secret list`) revealed a fact the process knew at boot.

- **The relay asks first.** `HostAdmin.canStoreSecrets` reports whether the host was built with
  a box, and `relayConnectionUpsert` refuses up front with a `503` naming the missing key.
  Ahead of the pre-flight probe deliberately: a host that can never keep the answer has no
  business spending an outbound call to learn it, or handing the plaintext to the provider on
  the way.
- **`503`, not `4xx`.** The request was well-formed and nothing about it needs correcting — it
  is the deployment that is incapable. It is also not a silent one: the refusal lands an
  ops-failure row like every other platform 5xx, so it is visible in the console rather than
  only on the screen of whoever tried to connect.
- **Typed, so the other consumers are covered too.** The box now throws
  `SecretBoxUnconfiguredError`, and the control-plane's error boundary maps it to the same 503.
  That reaches every path a misconfigured deployment can hit — rotation, subject keys, a dump
  seal — not just the one the incident happened to come through. It is the first case of the
  typed-error fix that `mapError`'s own header has called the durable answer to matching on
  message text.
- **The connect dialog says which thing is wrong.** A 503 now reads "this deployment can't store
  credentials right now — nothing was saved, and nothing was sent to Scrive", kept distinct from
  the provider refusing a key. A correct credential is never presented as the thing to fix.

`HostAdmin` gained a required `canStoreSecrets`; both in-tree adapters answer it from the box
they were constructed with.
