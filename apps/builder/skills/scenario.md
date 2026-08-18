# The scenario phase — the tests, before the code

The model is approved. Write `test/scenario.test.ts` from **`spec/concept.md`**,
then end the turn.

You write **only `test/**`** this turn. Nothing implements these yet, so they
will not pass — that is the point, not a problem to work around.

## Why this is its own phase

Every defect worth catching is two descriptions disagreeing. Generate the code
from the model and the code stops being an independent description of anything:
it is a *function* of the model. The second opinion has to come from somewhere
the model cannot reach, and the only candidate left is the tests.

A suite written *after* the handlers can only agree with whatever got built. It
will pass, it will look thorough, and it will ratify a wrong model perfectly and
forever. Written first, it is a claim the build has to satisfy.

So the direction is load-bearing:

> **Tests come from `spec/concept.md`. Never from `spec/model.ts`, and never by
> reading code that does not exist yet.**

## The mechanical rule that keeps it honest

> **Use literal inputs. Assert literal outputs. Import nothing from `spec/`.**

A test that builds its input from the model's schema *cannot* disagree with that
schema — it is the mirror again, one level down. A test that writes
`{ listId: 'L1', text: 'milk' }` as a literal can, and that disagreement is the
entire value. `pnpm lint:tests` enforces this; it is not a style preference.

Import from `src/` — `buildHost`, `seed` — because those are the things under
test. Never from `spec/model.ts`.

## What to write

The concept's §9 is the script; it was approved precisely so this file could be
written from it. Replay it against a temp dir through `buildHost`/`stub.invoke`.

**The happy path**, in the concept's own vocabulary. Then the part that decides
whether the suite is worth anything:

- **Every denial the concept names.** Wrong role. One customer's data invisible
  to another. The cross-tenant attacker reaching nothing.
- **A control beside every denial.** A closed door proves nothing on its own: the
  same assertion passes if access is broken for everyone, or if the module was
  never registered. Pair each refusal with a neighbouring door that opens.
- **Never a bare `.rejects.toThrow()`** — pin the message, or a typo'd operation
  name passes as a "denial".
- **Know which door closes.** An operation-level check THROWS; a proof-walk
  listing returns a filtered, possibly empty, list. Expecting `[]` from a
  throwing operation, or a throw from a walk, both read as "access control
  broken" when the code is right.
- **Principal ids come from `ulid()`**, never hand-written: the kernel validates
  the actor on every invoke, and `usr-admin-001` fails deep inside the first
  mutation with an error pointing nowhere near the cause.

Do not re-test engine invariants — state machines and append-only are verified
in the engines and inherited.

## What you cannot know yet, and what to do about it

You are writing against operations that do not exist. Their names and inputs are
in the approved model, so use them — that is a *contract*, not an implementation.
What you must not do is soften an assertion because you are unsure the build can
meet it. An assertion you cannot justify from the concept is one to leave out;
an assertion the build cannot satisfy is real information, and it belongs back in
the model phase.

If the concept does not say what should happen in some case, that is a gap in the
concept. Say so and stop. Do not invent the answer here — a test is a claim about
what was agreed, and inventing one quietly makes it agreed.

## When you are done

Write `test/scenario.test.ts` and stop. Say briefly which denials you pinned and
which cases the concept left open. The build begins next turn, and its job is to
make these pass — **it may not edit them.** A build that rewrites its own oracle
has no oracle.
