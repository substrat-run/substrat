---
'@substrat-run/cli': patch
---

`substrat push <dir>` builds again, instead of asking wrangler for a doubled path

The derived wrangler config was written at a path built with `join(opts.dir, …)` and
handed to `wrangler deploy --dry-run` as `--config`. But wrangler is spawned with `cwd`
set to that same directory, and `dir` arrives from argv unresolved — so a relative
`--config` was resolved a second time against the cwd:

```
✘ [ERROR] Could not read file: demos/ticket0/.wrangler.substrat.json
  ENOENT: … open '/home/runner/work/substrat/substrat/demos/ticket0/demos/ticket0/.wrangler.substrat.json'
```

This is why it never showed up in a local push. Running from inside the package makes
`dir` `'.'`, where joining twice is a no-op; only a push that NAMES a directory — which
is every push CI makes — could double it. So the CLI worked everywhere it was tried by
hand and failed on the one path nobody drives interactively.

The path is now `resolve`d, via an exported `generatedConfigPath` so the invariant is
pinned by a test rather than by the one line spelling it. The test asserts the property
that actually matters — the path is absolute, so resolving it again against the push
directory returns it unchanged — and goes red against the old `join`.
