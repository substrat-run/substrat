# UI — the screens

**app/** — built whenever the concept's Screens section names one (only an
explicit "API-only" skips it), in the scaffold, not deferred: Vite + React
served against the API, one view per line of the Screens section, principal
picker in the top bar, typed fetch wrappers over the routes, hash routing with
view state in the URL (`#/…` — refresh must not lose the screen). Keep it in
`app/` with its own package.json.

The operations in `spec/model.ts` are the surface you build against: call them
through the routes, with the inputs and returns the model declares. Never invent
a field the model does not return.

## When your writes are confined to app/

Some build turns run in two lanes: the API lane first, then you, the UI lane,
with the screens section and the model as your context. You can write only
`app/**`. A write anywhere else is refused, and that is not something to work
around.

When a screen needs something the API does not offer — an operation, a filter,
a field — do not reach for it. Add one line to `app/CONTRACT-GAPS.md`:

```md
- job/list-by-technician: the technician's day view lists only their own jobs
```

Then build the screen against what exists, and say in your reply which gaps you
recorded. The API lane reads that file on the next turn. One gap per line, no
repeats. Once the API offers it, delete the line.
