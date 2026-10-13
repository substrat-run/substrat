---
'@substrat-run/cli': minor
---

`substrat push`, `preview` and `push --check` now warn when the code names a host that `substrat.outbound` does not declare (#2193).

The egress worker refuses an undeclared host with `403 outbound refused`, which reads like an upstream error, and nothing checked harness code against the declaration before. The CLI now reads the worker entry and the modules it imports for `https://host` literals and `new URL('https://…')`, compares each with `substrat.outbound` using the same matcher the egress worker enforces with, and prints the file, the line and the exact `"outbound": […]` line to add. `--strict` turns the warning into an error, for CI. A declared host no literal names is a `note:` and never a failure. The scan is best effort: a host built at runtime or read from configuration is not found, and the message says so.
