# @substrat-run/model-view

## 0.6.2

### Patch Changes

- Updated dependencies [6933146]
- Updated dependencies [35bdba2]
  - @substrat-run/contracts@0.155.0

## 0.6.1

### Patch Changes

- Updated dependencies [bf18880]
- Updated dependencies [34c4455]
- Updated dependencies [1872bb7]
  - @substrat-run/contracts@0.154.0

## 0.6.0

### Minor Changes

- 17e7841: `parsePermissions` reads the system-held roles of a `PERMISSIONS.md` (the `### 2a. System-held roles` table `lint:permissions` writes once a role is declared `holder: 'system'`) into their own list, `systemRoles`, instead of reading them as roles a person can be given along with a role named `Role` from that table's header. `syncConcept` shows them in a table of their own under the roles. A file without the table has no system-held roles and reads as before. `permissionsSections` splits a `PERMISSIONS.md` into its sections and their `###` sub-sections, and `readRolesSection` reads the Roles section; both are shared with `substrat plan`'s classifier, so the two read every table under the same heading. A table under a sub-heading is no longer read as more rows of the section above it.

### Patch Changes

- @substrat-run/contracts@0.153.0

## 0.5.0

### Minor Changes

- 482e9b7: `parsePermissions` reads the registry's "Reserved to a system principal" column: `reserved` names the keys a manifest declares `holder: 'system'`, and `registryUnreadable` is set when the Registry table is not one `lint:permissions` writes (a header or a reservation cell it cannot read). `readRegistryTable` is that judgement, shared with `substrat plan`'s classifier; `syncConcept` refuses an unreadable registry rather than rendering it without descriptions.

### Patch Changes

- Updated dependencies [482e9b7]
  - @substrat-run/contracts@0.152.0

## 0.4.0

### Minor Changes

- 4efc88d: `PERMISSIONS.md` names the key each operation checks. A new Operations section lists every registered operation with the key it declares, and what that check narrows to: the scope, one record (id from an input field, or resolved in the handler), a whole ref, or a walk over rows. An operation whose handler checks a key with nothing declared is listed as "checked in code, not declared", never given a guessed key. To make this readable, the bound operations a module registers now carry the check each operation declares (`operationChecksOf` in `@substrat-run/contracts`, read the same way as the concurrency map), and the host itself ignores it. `substrat changeset` and `lint:changeset-bump` read the section: an operation moved to another key, narrowed differently, added or removed is a permission change, at least minor and listed for review. `substrat plan` shows each lifecycle transition with the key its operation checks and the roles and per-record grant shapes holding it. `@substrat-run/model-view`'s `parsePermissions` returns the section as `operations`.
- 55c961b: `substrat plan [dir]` shows the concept delta a design gate approves, computed from `model.json`, `openapi.json` and `PERMISSIONS.md` against the merge-base: the entities added, changed and removed with the model as a Mermaid diagram before and after, lifecycle changes with the operation that triggers each transition, the permission-diff table (key, description, roles before and after), the spec-version impact from the same classifier `substrat changeset` uses, and the decisions-log entry approving it would write. `--json` prints the delta for an agent. Nothing is written until a person approves: `substrat plan --approve <digest> --by <name> --why <reason>` appends the entry to the Decisions log of `spec/concept.md` and re-syncs it, and refuses a digest that no longer matches the delta, so an approval records what was shown. `@substrat-run/model-view` exports `entityDiagram` and `lifecycleDiagram`, the renderers behind the concept document's generated regions. The scaffold's playbook shows the concept delta at its design gate for a change to an existing model.

### Patch Changes

- Updated dependencies [8273013]
- Updated dependencies [4efc88d]
- Updated dependencies [a667881]
- Updated dependencies [f614b00]
  - @substrat-run/contracts@0.151.0

## 0.3.0

### Minor Changes

- 08ada82: `spec/concept.md` keeps its roles, entity model and processes true to the code. Three regions between `<!-- substrat:roles -->`, `<!-- substrat:entities -->` and `<!-- substrat:processes -->` markers are rendered from `PERMISSIONS.md` and `model.json`: a roles and permissions table, a Mermaid `erDiagram`, and a `stateDiagram-v2` per declared lifecycle. `substrat concept sync [dir]` rewrites them (the same input gives byte-identical output; `--check` writes nothing and exits 1 when the file is stale), and `@substrat-run/model-view` exports the pure `syncConcept` behind it. A new project ships a `spec/concept.md` with the markers and a decisions-log section, and its playbook tells the agent to sync after every model or permission change and to write the decisions-log entry itself.

### Patch Changes

- Updated dependencies [52cc41f]
- Updated dependencies [9024575]
- Updated dependencies [5f77e74]
  - @substrat-run/contracts@0.150.0

## 0.2.53

### Patch Changes

- Updated dependencies [0292dc0]
- Updated dependencies [b190e40]
- Updated dependencies [eda31d1]
- Updated dependencies [af096c6]
- Updated dependencies [39ccfea]
- Updated dependencies [6f5f12b]
- Updated dependencies [c7eb5fa]
- Updated dependencies [1df1b93]
- Updated dependencies [439efc1]
- Updated dependencies [3025154]
- Updated dependencies [9ae6644]
- Updated dependencies [d6ba289]
- Updated dependencies [2e503da]
- Updated dependencies [3608db6]
- Updated dependencies [9ceb545]
  - @substrat-run/contracts@0.149.0

## 0.2.52

### Patch Changes

- Updated dependencies [ad3ca19]
- Updated dependencies [c4a0352]
- Updated dependencies [f855218]
- Updated dependencies [a8b0842]
- Updated dependencies [00253e0]
- Updated dependencies [a9cbb6d]
- Updated dependencies [1bf5425]
  - @substrat-run/contracts@0.148.0

## 0.2.51

### Patch Changes

- Updated dependencies [9926c53]
- Updated dependencies [8ff761c]
- Updated dependencies [cb957bc]
- Updated dependencies [cb957bc]
- Updated dependencies [4d14a81]
- Updated dependencies [5b1c20f]
- Updated dependencies [1ce756e]
- Updated dependencies [b854efd]
- Updated dependencies [23840a7]
- Updated dependencies [1ad1426]
- Updated dependencies [b4bb938]
  - @substrat-run/contracts@0.147.0

## 0.2.50

### Patch Changes

- Updated dependencies [381f120]
- Updated dependencies [a55d75e]
- Updated dependencies [56b0af0]
  - @substrat-run/contracts@0.146.0

## 0.2.49

### Patch Changes

- Updated dependencies [e786ff0]
- Updated dependencies [f49cc49]
- Updated dependencies [6aaf822]
- Updated dependencies [2c75a0d]
- Updated dependencies [48e9503]
- Updated dependencies [5554b23]
- Updated dependencies [3782c4c]
- Updated dependencies [fac4f0a]
  - @substrat-run/contracts@0.145.0

## 0.2.48

### Patch Changes

- Updated dependencies [835409e]
- Updated dependencies [f84eb3a]
- Updated dependencies [e286f87]
- Updated dependencies [f6d671b]
  - @substrat-run/contracts@0.144.0

## 0.2.47

### Patch Changes

- Updated dependencies [e55e06c]
- Updated dependencies [7eb1b3c]
- Updated dependencies [dfb653b]
- Updated dependencies [6c44d57]
- Updated dependencies [9454e61]
  - @substrat-run/contracts@0.143.0

## 0.2.46

### Patch Changes

- Updated dependencies [6a81de3]
- Updated dependencies [c78098a]
- Updated dependencies [65305a1]
- Updated dependencies [c56bb34]
  - @substrat-run/contracts@0.142.0

## 0.2.45

### Patch Changes

- Updated dependencies [48be1e6]
- Updated dependencies [51bb25b]
  - @substrat-run/contracts@0.141.0

## 0.2.44

### Patch Changes

- Updated dependencies [32df62b]
- Updated dependencies [6154fd9]
- Updated dependencies [6d49012]
- Updated dependencies [55e6241]
- Updated dependencies [13a2067]
- Updated dependencies [72f8e92]
- Updated dependencies [100b47c]
- Updated dependencies [d42bb2b]
- Updated dependencies [e5bd928]
- Updated dependencies [ae80b0d]
- Updated dependencies [a1f40e5]
- Updated dependencies [0e3d406]
- Updated dependencies [fed1f3c]
- Updated dependencies [5405401]
- Updated dependencies [655141a]
- Updated dependencies [f1290ea]
- Updated dependencies [ced5130]
  - @substrat-run/contracts@0.140.0

## 0.2.43

### Patch Changes

- Updated dependencies [2a505df]
- Updated dependencies [ec25a00]
- Updated dependencies [4a14c92]
- Updated dependencies [48bf765]
  - @substrat-run/contracts@0.139.0

## 0.2.42

### Patch Changes

- Updated dependencies [d08b9b1]
- Updated dependencies [f33b1c3]
- Updated dependencies [bc6cc57]
- Updated dependencies [921dfa3]
  - @substrat-run/contracts@0.138.0

## 0.2.41

### Patch Changes

- Updated dependencies [7559e1a]
- Updated dependencies [21055d5]
- Updated dependencies [1c411fc]
- Updated dependencies [fcb587d]
  - @substrat-run/contracts@0.137.0

## 0.2.40

### Patch Changes

- Updated dependencies [fb1f624]
- Updated dependencies [4964eb8]
- Updated dependencies [b9b3b82]
- Updated dependencies [3ed9e9d]
- Updated dependencies [cdf32ab]
- Updated dependencies [7a28aea]
- Updated dependencies [7418e7e]
- Updated dependencies [18069f9]
  - @substrat-run/contracts@0.136.0

## 0.2.39

### Patch Changes

- Updated dependencies [1dca2da]
- Updated dependencies [8c64633]
- Updated dependencies [5d41454]
  - @substrat-run/contracts@0.135.0

## 0.2.38

### Patch Changes

- 4347933: The model page validates and marks an entity's `outsideText` fields beside its `erasable` ones.
- Updated dependencies [4347933]
  - @substrat-run/contracts@0.134.0

## 0.2.37

### Patch Changes

- Updated dependencies [a08c42e]
  - @substrat-run/contracts@0.133.0

## 0.2.36

### Patch Changes

- @substrat-run/contracts@0.132.1

## 0.2.35

### Patch Changes

- @substrat-run/contracts@0.132.0

## 0.2.34

### Patch Changes

- Updated dependencies [012b2c8]
  - @substrat-run/contracts@0.131.0

## 0.2.33

### Patch Changes

- @substrat-run/contracts@0.130.1

## 0.2.32

### Patch Changes

- Updated dependencies [b53ecff]
- Updated dependencies [8236531]
  - @substrat-run/contracts@0.130.0

## 0.2.31

### Patch Changes

- Updated dependencies [b213bfc]
  - @substrat-run/contracts@0.129.0

## 0.2.30

### Patch Changes

- Updated dependencies [260fb5a]
- Updated dependencies [4ba2a52]
- Updated dependencies [f79e8ba]
- Updated dependencies [ba75c81]
  - @substrat-run/contracts@0.128.0

## 0.2.29

### Patch Changes

- @substrat-run/contracts@0.127.0

## 0.2.28

### Patch Changes

- Updated dependencies [6d57761]
- Updated dependencies [c78e713]
- Updated dependencies [e1526a0]
  - @substrat-run/contracts@0.126.0

## 0.2.27

### Patch Changes

- Updated dependencies [e8d4860]
  - @substrat-run/contracts@0.125.0

## 0.2.26

### Patch Changes

- Updated dependencies [02942e0]
- Updated dependencies [45421e8]
  - @substrat-run/contracts@0.124.0

## 0.2.25

### Patch Changes

- Updated dependencies [f56e9eb]
- Updated dependencies [6b3cb45]
- Updated dependencies [ae19d01]
- Updated dependencies [30b09c6]
  - @substrat-run/contracts@0.123.0

## 0.2.24

### Patch Changes

- @substrat-run/contracts@0.122.1

## 0.2.23

### Patch Changes

- Updated dependencies [0803833]
  - @substrat-run/contracts@0.122.0

## 0.2.22

### Patch Changes

- Updated dependencies [a235648]
- Updated dependencies [6fc9950]
- Updated dependencies [48fea30]
- Updated dependencies [45b927e]
  - @substrat-run/contracts@0.121.0

## 0.2.21

### Patch Changes

- @substrat-run/contracts@0.120.0

## 0.2.20

### Patch Changes

- Updated dependencies [bb10d6d]
- Updated dependencies [929ec09]
- Updated dependencies [a9cfc4a]
- Updated dependencies [2c65b67]
- Updated dependencies [8009cd1]
- Updated dependencies [b080e0f]
- Updated dependencies [e7113ea]
  - @substrat-run/contracts@0.119.0

## 0.2.19

### Patch Changes

- Updated dependencies [030fafd]
- Updated dependencies [56a931b]
- Updated dependencies [429cc84]
  - @substrat-run/contracts@0.118.0

## 0.2.18

### Patch Changes

- Updated dependencies [6504a99]
- Updated dependencies [aabc227]
- Updated dependencies [fb37a3e]
- Updated dependencies [44299a1]
- Updated dependencies [d7eb089]
- Updated dependencies [105a4c3]
- Updated dependencies [a8c2c64]
- Updated dependencies [2fa5147]
- Updated dependencies [1f223f5]
  - @substrat-run/contracts@0.117.0

## 0.2.17

### Patch Changes

- Updated dependencies [e22db55]
- Updated dependencies [a67c59b]
- Updated dependencies [45d2f15]
- Updated dependencies [e99332e]
  - @substrat-run/contracts@0.116.0

## 0.2.16

### Patch Changes

- Updated dependencies [1a6fe4d]
  - @substrat-run/contracts@0.115.0

## 0.2.15

### Patch Changes

- Updated dependencies [f58aa74]
  - @substrat-run/contracts@0.114.0

## 0.2.14

### Patch Changes

- Updated dependencies [c146761]
- Updated dependencies [c3c92e9]
- Updated dependencies [2fc7187]
- Updated dependencies [7e6f925]
  - @substrat-run/contracts@0.113.0

## 0.2.13

### Patch Changes

- Updated dependencies [c697b15]
- Updated dependencies [db6a96f]
- Updated dependencies [221f94a]
  - @substrat-run/contracts@0.112.0

## 0.2.12

### Patch Changes

- Updated dependencies [f08bfc4]
- Updated dependencies [aaafae3]
- Updated dependencies [1b2506c]
  - @substrat-run/contracts@0.111.0

## 0.2.11

### Patch Changes

- Updated dependencies [a195037]
- Updated dependencies [8758949]
- Updated dependencies [d05689d]
- Updated dependencies [0257dbd]
- Updated dependencies [cb88aa1]
  - @substrat-run/contracts@0.110.0

## 0.2.10

### Patch Changes

- Updated dependencies [7aa3ea5]
- Updated dependencies [1e175ce]
  - @substrat-run/contracts@0.109.0

## 0.2.9

### Patch Changes

- Updated dependencies [5cf7ae4]
- Updated dependencies [44b53e4]
  - @substrat-run/contracts@0.108.0

## 0.2.8

### Patch Changes

- Updated dependencies [4a6c4c3]
  - @substrat-run/contracts@0.107.0

## 0.2.7

### Patch Changes

- @substrat-run/contracts@0.106.0

## 0.2.6

### Patch Changes

- @substrat-run/contracts@0.105.0

## 0.2.5

### Patch Changes

- Updated dependencies [dd999a9]
  - @substrat-run/contracts@0.104.0

## 0.2.4

### Patch Changes

- Updated dependencies [dc9995c]
- Updated dependencies [adf6bfb]
  - @substrat-run/contracts@0.103.0

## 0.2.3

### Patch Changes

- Updated dependencies [e7115b2]
- Updated dependencies [3e67ebe]
  - @substrat-run/contracts@0.102.0

## 0.2.2

### Patch Changes

- Updated dependencies [b61c4d5]
- Updated dependencies [306b893]
  - @substrat-run/contracts@0.101.0

## 0.2.1

### Patch Changes

- Updated dependencies [0cd3055]
- Updated dependencies [4b159da]
- Updated dependencies [d1a5a58]
- Updated dependencies [8912fb8]
- Updated dependencies [6b3e466]
  - @substrat-run/contracts@0.100.0

## 0.2.0

### Minor Changes

- 28a82c0: The entity model ships with a push, and the dashboard renders it (#1214). A vertical with
  a checked-in `model.json` (the artifact `pnpm lint:model` emits, #697) now carries it in
  the deploy manifest — metadata beside `envSpec` and `surfaces`, in no digest — and the
  dashboard's new Model tab renders the DEPLOYED version's model: the ER diagram, the entity
  cards, and the declared lifecycles (#844), for exactly the version the app runs.

  The rendering core moved out of the CLI into a new published package,
  `@substrat-run/model-view`: the pure `model.json → self-contained HTML` half of
  `substrat model view` (#756), with no `node:*` imports, so the CLI, the dashboard worker
  and the browser bundle all draw the same page from the same artifact. `substrat model
view` behaves exactly as before. Contracts gains `emittedModel` — the Zod twin of the
  `EmittedModel` interface — so the control plane re-parses the model at the trust boundary
  instead of trusting the CLI's serialization, and the control plane grows the matching
  owner-narrowed read: `GET /verticals/:slug/versions/:id/model`.

  A vertical with no `model.json` pushes exactly as before, and versions pushed by an older
  CLI stay readable — the tab shows an empty state pointing at the next push.

### Patch Changes

- Updated dependencies [e398034]
- Updated dependencies [28a82c0]
- Updated dependencies [d124e9a]
- Updated dependencies [8e29866]
- Updated dependencies [02793d9]
  - @substrat-run/contracts@0.99.0
