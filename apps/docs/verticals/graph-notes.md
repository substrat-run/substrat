# Graph notes (a scope store)

`demos/graph-notes` — notes kept in a [scope store](/concepts/scope-stores) instead of in the
vertical's own tables. It is the first vertical that declares a store and calls it, and it is
small on purpose: one store, one synthetic type, three operations.

::: warning Local only
The graph driver is registered, but no release of it is approved yet, so a hosted push that
declares this store is refused before anything is uploaded. The vertical runs in its test suite,
on the pure adapter, against a stand-in store or against the graph driver's own local process.
It has no worker, no login and no app.
:::

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/demo-graph-notes` |
| **Scope store** | `GRAPH`, driver `graph` |
| **Own tables** | none |
| **Roles** | `reader` (`notes:read`) · `writer` (`notes:read`, `notes:write`) · `admin` (both, plus `graph:install`) |
| **Permission surface** | [`PERMISSIONS.md`](https://github.com/substrat-run/substrat/blob/main/demos/graph-notes/PERMISSIONS.md) — 3 keys, 1 module, 3 roles |
| **Engines composed** | none |

## How a store-backed action runs

A store's door, `getScopeStore`, checks the tenant and the scope and nothing else. Module code
cannot reach it at all. So each action is two steps, in `src/notes.ts`:

1. Invoke the action's operation. Its handler only checks the key: `graph-notes/install-schema`
   (`graph:install`), `graph-notes/create-note` (`notes:write`) or `graph-notes/read-notes`
   (`notes:read`). A refused check never reaches the store.
2. Call the store. The call is not inside the operation's transaction, and a store refusal
   arrives as a `StoreError` carrying the store's own code in `storeCode`.

## The schema it installs

The store starts empty and the platform seeds nothing. `installSchema` uploads and installs one
synthetic part (`src/spec.ts`): a `Note` with a required `title` and an optional `body`, both
text. Installing it again is a no-op on the store's side and answers `alreadyInstalled: true`.

## Sessions

Every call to the graph store names a session. Each action opens a fresh one: `putScope` at
the part's level, with the part as the session's schema and data part, and then its calls in
that session. A session left with only those settings expires after a day idle, and the store
refuses its id from then on, so the vertical never reuses one.

A note the store finds invalid is answered `200` with an `invalid` outcome rather than as an
error, so `createNote` refuses it itself with `validation_failed`, naming the attribute each of
the store's issues is about.

## Running it against the real store

The suite's `test/graph-store.test.ts` runs the same actions against the graph driver's local
process. It is opt in. Start the process from the driver's repository, with a Python
environment that has it installed, and name its address:

```sh
python -m ontorepo_scope_store.local --directory .graph-store --port 8955
GRAPH_STORE_URL=http://127.0.0.1:8955 pnpm --filter @substrat-run/demo-graph-notes test
```

Each run uses a fresh tenant and scope, so a process kept running between runs starts every
run with an empty store.
