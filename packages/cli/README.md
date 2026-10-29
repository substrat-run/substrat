# @substrat-run/cli

The `substrat` command — authenticated deploy tooling for
[Substrat](https://github.com/substrat-run/substrat). It pushes a vertical to the
platform, then manages its versions and release channels.

A vertical is built on the platform and promoted deliberately: `push` submits source for an
immutable release; `promote` binds a channel (e.g. a scope's production
pointer) to a version; `publish`/`unpublish` control the marketplace catalog. Nothing
goes live as a side effect of uploading.

## Install

```sh
# one-off
pnpm dlx @substrat-run/cli push ./my-vertical

# or add it to a vertical's devDependencies
pnpm add -D @substrat-run/cli
```

`push` captures the working tree, including uncommitted and untracked files. It excludes
ignored files, local credentials, dependencies and generated output. For pnpm monorepos,
it includes the selected app, nested UI packages, workspace dependencies and root build
configuration. The platform installs with a frozen lockfile, runs checks and builds the
release. `push --check` remains the local verification command. Promotion and rollback
reuse built outputs without rebuilding source.

## Commands

```sh
substrat login                 # authenticate against the control plane
substrat dev [dir]             # run the project's dev script with local request traces
substrat whoami                # show the current identity + reachable tenants
substrat push <dir>            # submit source for a platform-built release
substrat versions <slug>       # list a vertical's uploaded versions
substrat promote <slug> <ver>  # point a channel at a version (the deliberate go-live)
substrat publish <slug>        # list the vertical in the marketplace catalog
substrat unpublish <slug>      # remove it from the catalog
substrat help                  # full usage
```

Run `substrat help` for the authoritative flag set — this list is a map, not the spec.

To make an application description queryable in the dashboard's Ask assistant, opt in
with `"substrat": { "concept": "spec/concept.md" }` in the application's `package.json`.
The next push snapshots that file with the release. The whole selected document becomes
readable to dashboard members who can read the application; use a curated Markdown file
when the full concept includes internal design decisions. Publication is off by default.
The file must stay within the application directory and fit in 64 KiB of UTF-8 text.

`substrat dev` runs the project's `pnpm run dev` with its normal output and exit code.
When the local server mounts `invocationLog` (as the scaffold does), completed requests
print a compact trace line and are kept under `.data/substrat-traces/` in the project.
The newest 256 requests, up to 8 MiB total, are retained. SQL parameter values and
request and response bodies are not recorded. `--no-trace` runs the same script without
the trace preload.

The trace records SQL statement text, duration and row counts. When source maps are
available, error stacks point at the original source. **Not recorded, and why:** bound
SQL parameters can contain personal data or credentials, so the local file store omits
them. Revisit that decision if a concrete debugging case needs values and a safe,
explicit opt-in can be designed. Event steps name the type and entity but do not claim
`from → to` lifecycle moves: the trace omits event payloads, and a checked transition
can still roll back. Revisit this when the local reader can derive committed moves from
event history and the declared lifecycle without guessing.

Local HTTP measurement (macOS arm64, Node 22.22.3; four runs of 100 warmup and
400 sequential requests through the same `invocationLog` fixture with a check and
SQL step): median latency was 0.20–0.36 ms with `--no-trace` and 1.66–1.97 ms with
tracing, about 1.5 ms extra. The p95 ranges were 0.32–2.75 ms and 2.21–7.94 ms;
the median meets the few-millisecond target, while p95 varied under machine load
and is not separately proven to stay within it.

## Documentation

**https://substrat.net/guide/deploying** — authentication, the push/promote model, channels,
and the marketplace flow, end to end.

## Status

Pre-release (0.x): commands and flags change without notice until the platform GAs.
