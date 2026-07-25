# @substrat-run/cli

The `substrat` command — authenticated deploy tooling for
[Substrat](https://github.com/substrat-run/substrat). It pushes a vertical to the
platform, then manages its versions and release channels.

A vertical is uploaded once and promoted deliberately: `push` uploads an immutable,
content-addressed version; `promote` binds a channel (e.g. a scope's production
pointer) to a version; `publish`/`unpublish` control the marketplace catalog. Nothing
goes live as a side effect of uploading.

## Install

```sh
# one-off
pnpm dlx @substrat-run/cli push ./my-vertical

# or add it to a vertical's devDependencies
pnpm add -D @substrat-run/cli
```

## Commands

```sh
substrat login                 # authenticate against the control plane
substrat whoami                # show the current identity + reachable tenants
substrat push <dir>            # upload a vertical as a new immutable version
substrat versions <slug>       # list a vertical's uploaded versions
substrat promote <slug> <ver>  # point a channel at a version (the deliberate go-live)
substrat publish <slug>        # list the vertical in the marketplace catalog
substrat unpublish <slug>      # remove it from the catalog
substrat help                  # full usage
```

Run `substrat help` for the authoritative flag set — this list is a map, not the spec.

## Documentation

**https://substrat.net/guide/deploying** — authentication, the push/promote model, channels,
and the marketplace flow, end to end.

## Status

Pre-release (0.x): commands and flags change without notice until the platform GAs.
