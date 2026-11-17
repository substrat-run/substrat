# The seeded review corpus

The changes the hosted review runner's reader model is measured against before it is chosen
(RFC [hosted-review-runner](../../../docs/rfc/hosted-review-runner.md) Q1a and Q7 C, #2365).
`REVIEW_MODEL` is set by the owner from these numbers; nothing here sets it.

## A seed

`seeds/<id>/` holds two files:

- `change.patch`: the change, as a patch over real files of this repository at a pinned
  commit. The base files are read from git, so a seed carries only its diff.
- `seed.json`: the pinned commit and root, the base files, where the seed comes from, and what a
  reader owes it.

A seed that changes a vertical's model carries what its emitters produce from that change
(migrations, `model.json`, `openapi.json`, the client, `PERMISSIONS.md`, `CONFORMANCE.md`,
`MIGRATIONS.md`), as a real push does. The reader is not sent the generated and emitted ones, but
sees them listed as changed; leaving them out would hand it a second defect the seed is not about.

Three kinds:

| Kind | What it is | What it owes |
|---|---|---|
| `bad` | a known-bad change, rebuilt from an incident or rule of this repository, at least one per checklist item | a finding of its item, at one of the places named |
| `clean` | a change that is clean against the checklist; several are twins of a bad seed with the defect fixed | nothing |
| `outside` | a real bug that no checklist item covers (#1655, #1388) | nothing: a reader held to the checklist does not report it |

An expectation names its item and its places by text, not by line number: `from` is text that
occurs once in the changed file, widened by `before`/`after` lines or up to a `through` anchor.
`anyOf` lists alternatives, any one of which counts.

A seed may also `allow` findings that are right but not what it is for: a seed that adds an
operation with no test to carry another defect allows S8 there. An allowed finding counts as
neither caught nor false.

Seeds are this repository's own history only, and name no customer.

## The score

Each read is the hosted job's own: the seed's diff from `diffReview` under the default budgets,
the job's system text and prompt (gates all `not run`, as in phase 1), `REVIEW_CALL` at the job's
output cap, and `readReply`, the assembler's drop rule included. Only findings the assembler keeps
are scored.

- **Caught**: an expectation is met when a kept finding has its item and a line in one of its
  places. More findings on the same expectation are not false.
- **False finding**: a kept finding that meets no expectation and is not allowed, on any seed.
- **Clean flagged**: reads of a `clean` or `outside` seed with any finding.
- **Dropped**: findings the assembler threw away (a quote not on its line, an item not
  judgement-marked, an off-spec entry). A model that drops many is guessing.
- Tokens, list cost and latency per read. The cost is the rate card's list price; a
  partner-served id is priced at its vendor's row.

The scorer's rules and every seed's integrity (it applies, its diff is readable, each place lands
on a line the change adds or alters, every judgement item has a bad seed) are held in CI by
`pnpm test:review-corpus`. No model is called there.

## Running it (opt-in, paid)

```sh
# what a pass would cost at worst, with no call made
pnpm review-corpus --dry-run --model cloudflare:@cf/zai-org/glm-5.3

# the read: refused before any call if the worst case is over the budget
pnpm review-corpus --budget 10 --repeat 3 --env-file <path to .env> \
  --model cloudflare:@cf/zai-org/glm-5.3 --model cloudflare:@cf/deepseek-ai/deepseek-v4.1-flash-1017 \
  --out /tmp/review-corpus.json
```

Only the `cloudflare` gateway row is a candidate (Q3e). The harness reads its variables from the
environment, or only those lines of `--env-file`, and never prints them. It writes ids, counts and
numbers, never code or model text.
