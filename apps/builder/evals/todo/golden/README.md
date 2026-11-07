# Golden todo, version 2.1

The reviewed reference for the `todo` fixture, approved 7 November 2026. A stage test starts from
these files instead of rebuilding them: `pnpm builder evals --eval todo --from scaffold`.

It came from a real build, then four defects were fixed by hand: a dialog component that was never
registered, a server port that disagreed with the app's proxy, a missing pnpm pin, and a join that
stored whatever address the caller typed. The last one was found by a design review, and uses the
guard from `demos/todo/src/app.ts`. It was proven by running it: 20 tests, 28 API checks and 18 browser
checks, on default ports.

Frozen means frozen. A change is a new version, and results against this one keep their meaning. It
stops at 95 of 100, because no build has produced a worker yet. Version 2 added email invites, and 2.1
asks to send them: `substrat.sendsEmail`, which a hosted send is refused without.
