# Substrat, end to end

This is the book. The rest of these docs are a reference — you arrive with a question,
find the page that answers it, and leave. That works well once you know the shape of the
system, and badly before. Nothing in a reference tells you how the pieces *join*: which
thing calls which, what happens between the moment a request lands and the moment a row
is written, who retries what when it fails.

So this section is the other thing. Thirteen chapters, meant to be read in order, front to
back, in a long afternoon. It assumes nothing except that you have written server software
before. It repeats very little — where a reference page already says a thing well, this
book links to it and moves on.

## What you will know at the end

- What the words mean: tenant, scope, module, engine, vertical, the spine, consumer, executor,
  connector, platform intent.
- What a scope is, why every one of them is its own database, and what that buys.
- The complete path of one HTTP request, from hostname to SQL and back, with every hop
  named.
- What a handler can reach, what it cannot, and why each ban exists. Also why plain SQL with
  no query builder is safe enough, why timestamps are text, and what a slow `await` blocks.
- How an event gets from `ctx.emit` to a consumer in another module, what happens when
  the consumer throws, and which failures retry and which do not. Also how a platform intent
  gets run in seconds instead of at the next sweep.
- How permission checks are answered without a network call.
- Why engines never call each other, and what they do instead.
- How separate apps communicate through peer calls and exported events, who authorizes
  each direction, and what a pause, failure or replay does.
- How notifications turn an occasion into durable email, and how the new assistant
  engine separates conversation history, a running model and approval of a change.
- What `substrat push` actually does, and what happens to data across a version change.
- What the two background clocks are, what each sweeps, and why both are alarms rather
  than crons.
- What the platform records about a running app, from sampled traffic to exact event history,
  and how a record joins to the request that changed it.
- Which log is the audit log for which question, and how events leave their scope for a lake
  you can query with SQL.
- How a vertical meters and bills its own customers, how the platform meters a tenant, and
  what is not counted yet.
- What breaks in production, where you look, and what the lifecycle states mean.

## How to read it

Straight through. Each chapter ends where the next begins, and later chapters lean on
earlier ones — chapter 5 assumes chapter 4's picture of a handler, chapter 9 assumes
chapter 5's outbox, and chapters 10 to 12 assume both. If a word stops you, the glossary is
at the end of chapter 1. The **Next** link at the foot of every page is the intended path.

Two chapters are worth reading even out of order, because they are the ones the
reference genuinely does not cover anywhere: [The life of one
event](/book/05-one-event) and [The two clocks](/book/09-the-two-clocks).

## Read it in one file

The whole book is also published as a single document, three ways:

- **[book.epub](/book.epub)** — a real EPUB 3, with a cover and a table of contents. The
  link downloads the file; open it from there in Apple Books, Kobo, or anything else that
  reads EPUB, and it remembers where you got to and lets you set the type the way you like
  it. On a phone that is one step more than tapping a link — see below.
- **[book.txt](/book.txt)** — every chapter concatenated, plain markdown. Good for
  printing, for `pandoc`, or for handing to a model in one shot.
- **<a href="/book/read.html" target="_self">book/read.html</a>** — the same thing as one
  scrolling, printable web page.

All three are generated from these chapters at build time, so they cannot fall behind.
The EPUB and printable HTML include the diagrams; the text edition describes those
same figures in words.

::: tip Reading it on a phone
There is no URL that opens Books directly — iOS decides that from the file itself. Tapping
**book.epub** in Safari downloads it; opening it from Files then offers Books, which syncs
it to your other devices. On a Mac, double-clicking the download does the same thing in one
step.
:::

If you want the *reference* in one file instead — every page on this site, not just the
book — that is [llms-full.txt](/llms-full.txt), and the index agents read first is
[llms.txt](/llms.txt).

## What changed in this edition

**Updated 15 October 2026.** This edition reviews the three complete weeks
[21–27 September](/changelog/2026-w39), [28 September–4 October](/changelog/2026-w40)
and [5–11 October](/changelog/2026-w41). It also covers the assistant engine's first
implementation, which landed on 15 October, with its remaining integration work stated
explicitly. The chapter numbers and reading order stay the same.

| If you read the previous edition | Where to return |
|---|---|
| Peer calls, exported events, permissions in both directions, instance selection, watermarks and replay | [Chapter 7](/book/07-engines-and-verticals), with two new diagrams |
| Notifications and transactional email; the assistant's record, lease and approvals | [Chapter 7](/book/07-engines-and-verticals), with two more diagrams |
| Derived creates and stamps, archive/trash, attachment text search, live reads and opaque paging cursors | [Chapter 4](/book/04-inside-an-operation) |
| Capability links, binding invites, verified email and permission shapes that reach existing users | [Chapter 6](/book/06-permissions-and-identity) |
| Copies that keep history without re-running the source's work, and migration integrity | [Chapter 8](/book/08-one-deploy) |
| The supplied sweeper, durable off switches and cross-app delivery in the sweep | [Chapter 9](/book/09-the-two-clocks) |
| Findings as an inbox of problems to resolve, and the current Observability navigation | [Chapter 10](/book/10-seeing-what-happened) |
| Erasure reaching a module's own tables | [Chapter 11](/book/11-audit-and-the-lake) |

The review also checks what the book already covered: the platform-written request log,
background invocation lines and the daily storage gauge remain in chapters 10 and 12.
Chapter 13's old statements that storage was unmeasured and denials had no invocation id
have been corrected. The lake gateway's restricted, unconfigured status is kept consistent
with chapter 11. Smaller demo and UI fixes remain in the weekly changelog.

## A note on honesty

Substrat is 0.x. Several things in this book are described as built because they are,
and a few are described as not built because they are not. Where a mechanism has a known
gap, the chapter says so in the place you would otherwise assume it was covered, rather
than in a footnote. [What Substrat doesn't have (yet)](/guide/what-substrat-lacks) is the
concentrated version of that.
