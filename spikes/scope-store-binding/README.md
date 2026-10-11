# Scope-store binding spike

Evidence for [the scope-stores RFC](../../docs/rfc/scope-stores.md) and [#2207](https://github.com/substrat-run/substrat/issues/2207).
Not a workspace member: nothing here is imported by a package, and `pnpm-lock.yaml` at the
repo root does not name it. The lockfile in this directory is its own.

The store is a counter in the Durable Object's SQLite. It is not Ontomate, and it keeps
no state at module level.

## Run

From this directory, with Node and pnpm (the repo's `packageManager` is `pnpm@10.10.0`):

```
pnpm install --ignore-workspace
node run.mjs
```

`run.mjs` drives ten workers in one miniflare: one shared store script, one store script
that requires a signature, and one store script per vertical. A non-zero exit is a failed
assertion. Results are in [FINDINGS.md](FINDINGS.md).

## Python

The same counter as a Python Durable Object, same script only (no cross-script binding).
Needs `uv` and Python 3.12 — `workers-py` pulls `pyjson5`, which has no wheel for newer
interpreters and does not build here without MSVC.

```
cd python
uv sync --python 3.12
node probe.mjs
```
