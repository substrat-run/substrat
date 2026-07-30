---
'@substrat-run/cli': minor
---

`substrat version` (and `--version` / `-v`) prints the CLI version, and an out-of-date
CLI now nudges you to upgrade.

The version string is read from the package.json shipped in the tarball, so it's always
what npm installed. The top-level flag doesn't collide with `push --version` / `promote
--version` (the *vertical's* semver) — those remain flags to their commands; only the
bare `argv[0]` form prints the CLI version, the same slot `--help`/`-h` already live in.

The freshness check is driven by the control plane, not npm's `latest` tag — the server
is the authority on whether this CLI is still *compatible*. Authenticated responses may
advertise `x-substrat-cli-min-version` (the compat floor) and `x-substrat-cli-latest-version`;
`push`/`promote` read them off the responses they already make (no extra round trip) and
print a one-line upgrade hint to **stderr, TTY only** — so scripted/CI runs stay silent
and `push`'s parseable stdout is never touched. Below the floor is flagged as a hard
upgrade; merely behind `latest` is a gentle nudge. The advisory never throws and is a
no-op until the server starts sending the headers.
