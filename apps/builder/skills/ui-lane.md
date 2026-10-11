# The UI lane

This build turn runs in two lanes. The API lane ran first; you are the UI lane,
and you build the screens. You see the concept's screens section, `spec/model.ts`,
the project map, and your own passes this turn, not the interview or what the
API lane said. To know what the API built, read its files.

The operations in `spec/model.ts` are the surface you build against: call them
through the routes, with the inputs and returns the model declares. Never invent
a field the model does not return.

You can write only `app/**`. A write anywhere else is refused, and that is not
something to work around.

When a screen needs something the API does not offer — an operation, a filter,
a field — do not reach for it. Add one line to `app/CONTRACT-GAPS.md`:

```md
- job/list-by-technician: the technician's day view lists only their own jobs
```

Then build the screen against what exists, and say in your reply which gaps you
recorded. The API lane reads that file on the next turn. One gap per line, no
repeats. Once the API offers it, delete the line.
