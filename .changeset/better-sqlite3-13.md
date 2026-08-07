---
"@substrat-run/adapter-sqlite": minor
"@substrat-run/control-plane-api": minor
"create-substrat": minor
---

chore(deps): one better-sqlite3, and it is 13.0.3

The workspace had drifted onto three copies — `^13.0.3` in adapter-sqlite, `^13.0.2` in
manyfold, `^12.0.0` in ten other packages — which is how `pnpm install` started failing.

v13 changed its packaging: it **dropped its install script** and now ships prebuilt binaries
for all eight platform targets inside the tarball, declaring `"gypfile": false`. It still
ships a `binding.gyp`, and pnpm applies npm's legacy rule — *binding.gyp present + no install
script ⇒ `node-gyp rebuild`* — ignoring that opt-out. With `better-sqlite3` on the
`onlyBuiltDependencies` allowlist, pnpm ran that phantom build and died wherever `node-gyp`
isn't installed. CI images ship one, which is why it only bit locally.

So the allowlist entry is now the bug rather than the fix: nothing in the tree needs
compiling. Dropping `better-sqlite3` from `onlyBuiltDependencies` is the whole repair — the
prebuilt binary is already on disk and `lib/binding.js` finds it.

Two things had to move for that to be true everywhere:

- **`overrides: { "better-sqlite3": "13.0.3" }`** — better-auth declares a `^12.0.0` peer, so
  pnpm was quietly resolving a *second*, duplicate v12 copy alongside ours. That copy needs a
  real build, and once better-sqlite3 left the allowlist it would have arrived with no binary
  at all on a fresh clone. The override collapses the tree to one version; a matching
  `peerDependencyRules.allowedVersions` records that v13 is deliberate, not unnoticed. All six
  better-auth packages pass on it.
- **`create-substrat`** no longer scaffolds `onlyBuiltDependencies: ['better-sqlite3']`, which
  would have handed every new project the same failure.

`@types/better-sqlite3` goes `^7.6.x` → `^9.6.0` to match. Requires Node >= 22, which CI
(22 and 24) already satisfies.
