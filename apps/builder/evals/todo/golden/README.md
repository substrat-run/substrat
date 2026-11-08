# Golden todo, version 3

The reviewed reference for the `todo` fixture. A stage test starts from these files instead of
rebuilding them: `pnpm builder evals --eval todo --from scaffold`.

It came from a real build, then four defects were fixed by hand: a dialog component that was never
registered, a server port that disagreed with the app's proxy, a missing pnpm pin, and a join that
stored whatever address the caller typed. The last one was found by a design review. Version 2.1 was
approved on 7 November 2026, and proven by running it: 20 tests, 28 API checks and 18 browser checks,
on default ports.

Version 3 keeps that design and changes what moved under it. A join may no longer take an address
(K-61): `lists/join` records the one the issuer verified, `ctx.verifiedEmail`, and refuses without
it, so the dev server's guard is gone and it joins a person on `/api/me` once the issuer has verified
them. An invitation also asks `list:contribute` on the list, as `todo/invite` does, because the share
it becomes is made by a consumer, where nothing re-checks the inviter. And it can be deployed:
`src/worker.ts` and `tsconfig.worker.json` from the template, with the join named in `workerDoor`,
and the `runtimeNeeds` the scaffold writes; `pnpm typecheck` compiles the worker too. Its packages
are the 0.187 release. Proven by running it: 22 tests, 24 API checks, the worker signing a person in,
joining them and creating a list, and the eight browser steps, on a click-through with two of its own
faults fixed.

Frozen means frozen. A change is a new version, and results against this one keep their meaning.
Version 2 added email invites, and 2.1 asks to send them: `substrat.sendsEmail`, which a hosted send
is refused without.
