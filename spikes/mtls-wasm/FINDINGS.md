# Findings: a client certificate presented from a Worker

Run locally on macOS, 29 October 2026, in `wrangler dev` (local workerd, wrangler from this
repo's lockfile), against BankID's test API (`appapi2.test.bankid.com`) with BankID's published
test certificate, `FPTestcert5_20240610.p12` (passphrase `qwerty123`). No Cloudflare account and
no dispatch namespace was used. Cited by [docs/rfc/mtls-hop.md](../../docs/rfc/mtls-hop.md).

## Question

A Worker's `fetch` takes no client certificate, and `node:tls` ignores one. Can a Worker present
a client certificate anyway, by opening a raw TCP socket and running TLS itself — with a
maintained TLS library, not our own cryptography?

## What was built

- `tls-wasm/` — rustls 0.23 with the ring provider, compiled to `wasm32-unknown-unknown` and
  bound with wasm-bindgen 0.2.129. `src/lib.rs` is ~90 lines: build a `ClientConfig` that trusts
  only the roots it is handed and presents the given chain and key, then move bytes in
  (`receive`) and out (`transmit`). Nothing in it is cryptography.
- `worker/` — `GET /probe?env=test` opens `connect({ hostname, port: 443 }, { secureTransport:
  'off' })` from `cloudflare:sockets`, drives the handshake through the module, sends one
  HTTP/1.1 `POST /rp/v6.0/collect` for an all-zero `orderRef`, and logs one line per stage.

## Results

| run | answer |
|---|---|
| Node `https.request` with the certificate (baseline) | `400 {"errorCode":"invalidParameters","details":"Invalid orderRef"}` |
| Node, no certificate | `403 Forbidden` (nginx) — so a `400` means the certificate was accepted |
| Worker, test root + test certificate | `400 invalidParameters`, TLSv1.3 |
| Worker, test certificate and root against the production host | `tls: invalid peer certificate: UnknownIssuer` |

The passing run, stage by stage:

```
tls.config      35 ms
tcp.open       117 ms
tls.handshake  215 ms  protocol TLSv1_3
http.response  289 ms  status 400, 187 bytes
```

`openssl s_client` against the same host negotiates TLSv1.3 with `TLS_AES_256_GCM_SHA384`.
The module is 493 818 bytes, 204 214 gzipped (`opt-level = "z"`, LTO, no `wasm-opt`).

## What this does not show

- **Cloudflare's edge.** Only local workerd ran. The edge is the next check, and the RFC's first
  step.
- **A dispatched vertical.** Not attempted, and not expected to work: an outbound worker disables
  `connect()` for every script it is attached to, and the router attaches one to every vertical
  (D-46). That is why the RFC puts the transport in the control plane.
- **Load, CPU limits, or a long-lived connection.** One request per connection, `Connection:
  close`.

## Reproducing

Needs a Rust toolchain with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli` at the
version `tls-wasm/Cargo.toml` pins, and a clang that targets WASM (ring compiles C; Apple's clang
does not target WASM, Homebrew's `llvm` does).

```sh
cd tls-wasm
CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang \
AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/llvm-ar \
  cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir ../worker/src/pkg \
  target/wasm32-unknown-unknown/release/mtls_wasm.wasm
```

Convert the test certificate (`openssl pkcs12 -in FPTestcert5_20240610.p12 -clcerts -nokeys
-legacy -passin pass:qwerty123`, and `-nocerts -nodes` for the key) and put `CLIENT_CERT`,
`CLIENT_KEY` and `ROOT_CA` (BankID's test root, `BANKID_ROOT_CA.test` in
`demos/auth-server/src/bankid.ts`) in `worker/.dev.vars`. Neither the certificate nor the built
module is checked in. Then `wrangler dev` in `worker/` and `GET /probe?env=test`.
