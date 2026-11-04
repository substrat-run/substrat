# Store facets spike

Evidence for [D-70](../../docs/decisions/D-070-a-store-driver-s-code-runs-in-its-own-loaded-isolate-outside-the-verifier-with-no-network.md)
and [#2830](https://github.com/substrat-run/substrat/issues/2830). This is not a workspace member. Nothing
here is imported by a package. The lockfile in this directory is its own.

The question is whether a store driver's code can run in an isolate of its own, per object, with no
network, beside a supervisor that holds everything the driver must not reach. Concretely:

- the supervisor is the script's only executed code;
- the driver's modules travel inert and are loaded through the Worker Loader;
- the driver's class runs as a Durable Object facet with storage of its own.

| File | What it is |
| --- | --- |
| `src/supervisor.mjs` | The supervisor: the loader id per object, `globalOutbound: null`, an empty env, the facet. |
| `src/drivers/` | A JavaScript and a Python probe driver. Each operation reports one fact. |
| `build-graph.mjs` | Packs a real driver release into `src/graph-release.bin`, to measure its cold start and heap. |
| `probes.mjs` | The probe sequence, one check per question D-70's **Measured** table asks. |
| `run-local.mjs` | The sequence on local workerd. No account is needed. |
| `probe.mjs` | The sequence against the deployed spike. It prints the block to paste back. |
| `wrangler.jsonc`, `dispatcher/` | The supervisor for a dispatch namespace, and the ordinary worker in front of it. |

## Run locally

```
pnpm install --ignore-workspace
node build-graph.mjs
node run-local.mjs
```

A non-zero exit is a failed check. Local results are in [FINDINGS.md](FINDINGS.md).

## Run on a real dispatch namespace

[RUNBOOK.md](RUNBOOK.md). A person runs it with a Cloudflare credential. Nothing in this directory
runs it for them.
