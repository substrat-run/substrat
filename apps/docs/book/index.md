# Substrat, end to end

This is the book. The rest of these docs are a reference — you arrive with a question,
find the page that answers it, and leave. That works well once you know the shape of the
system, and badly before. Nothing in a reference tells you how the pieces *join*: which
thing calls which, what happens between the moment a request lands and the moment a row
is written, who retries what when it fails.

So this section is the other thing. Fifteen chapters, meant to be read in order, front to
back, in a long afternoon. It assumes nothing except that you have written server software
before. It repeats very little — where a reference page already says a thing well, this
book links to it and moves on.

## What you will know at the end

- What the words mean: tenant, scope, module, engine, vertical, door, plugin, the spine,
  consumer, executor, connector, platform intent, store, request id.
- What a scope is, why every one of them is its own database, and what that buys.
- The complete path of one HTTP request, from hostname to SQL and back, with every hop
  named, including the door that decides who a signed-in person is in this app.
- What a handler can reach, what it cannot, and why each ban exists. Also why plain SQL with
  no query builder is safe enough, why timestamps are text, and what a slow `await` blocks.
- How an event gets from `ctx.emit` to a consumer in another module, what happens when
  the consumer throws, and which failures retry and which do not. Also how a platform intent
  gets run in seconds instead of at the next sweep.
- How permission checks are answered without a network call.
- Why engines never call each other, and what they do instead.
- How notifications turn an occasion into durable email or a daily digest, and how the
  assistant engine separates conversation history, a running model and approval of a change.
- Where the line between a module and another app falls, and what crosses it: peer calls and
  exported events, a plugin that takes its people from another app, a call made as the
  signed-in person, and an app that creates tenants.
- What the platform supplies for screens, and what it deliberately does not.
- What `substrat push` actually does, who builds the release, and what happens to data across a
  version change, including a migration that would lose it.
- What the two background clocks are, what each sweeps, and why both are alarms rather
  than crons.
- What the platform records about a running app, from sampled traffic to exact event history,
  and how one request id joins a response, its log lines, its events and the records it touched.
- Which log is the audit log for which question, and how events leave their scope for a lake
  you can query with SQL.
- How a vertical meters and bills its own customers, how the platform meters a tenant, and
  what is not counted yet.
- What breaks in production, where you look, and what the lifecycle states mean.

## How to read it

Straight through. Each chapter ends where the next begins, and later chapters lean on
earlier ones — chapter 5 assumes chapter 4's picture of a handler, chapter 11 assumes
chapter 5's outbox, chapter 8 leans on chapters 3 and 6, and chapters 12 to 14 assume
chapters 4 and 5. If a word stops you, the glossary is
at the end of chapter 1. The **Next** link at the foot of every page is the intended path.

Two chapters are worth reading even out of order, because they are the ones the
reference genuinely does not cover anywhere: [The life of one
event](/book/05-one-event) and [The two clocks](/book/11-the-two-clocks).

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

**Third edition, 20 November 2026.** This edition reviews the five complete weeks
[12–18 October](/changelog/2026-w42), [19–25 October](/changelog/2026-w43),
[26 October–1 November](/changelog/2026-w44), [2–8 November](/changelog/2026-w45) and
[9–15 November](/changelog/2026-w46), and what merged from 16 to 20 November. Two chapters are
new, so the book has fifteen and the chapters from the old chapter 8 onwards moved up by two.
Their addresses changed with their numbers.

| If you read the previous edition | Where to return |
|---|---|
| Peer calls and exported events, moved out of chapter 7; a plugin that takes its people from another app; a call made as the signed-in person; an app that creates tenants; where the module and vertical line falls | [Chapter 8](/book/08-apps-made-of-apps), new |
| Web components for screens, the generated client from the browser's side, files served as the person | [Chapter 9](/book/09-screens), new |
| The worker door: joining on arrival, invites admitted by verified address, request ids and problem documents on the way out | [Chapter 3](/book/03-one-request) |
| `ctx.verifiedEmail` and `ctx.requestId`, `inList` and `csvTable`, unchecked operations, declarations refused at load, streamed attachments and upload and download links | [Chapter 4](/book/04-inside-an-operation) |
| Connections that land by declaration, a scope's own connection, connectors a vertical ships, mail as an inbound connection | [Chapter 5](/book/05-one-event) |
| Keys reserved to the platform, system-held roles, bind links, member invites without a link | [Chapter 6](/book/06-permissions-and-identity) |
| Platform-built releases, the migration data-loss fence, bound promote reviews, previews you can sign in to, copies of any size | [Chapter 10](/book/10-one-deploy) |
| Request ids handed out, the Logs view, local traces, AI explanations and Ask | [Chapter 12](/book/12-seeing-what-happened) |
| A failure's text kept from other tenants, admin writes that commit with their row, erasure reaching stores | [Chapter 13](/book/13-audit-and-the-lake) |
| Usage captured by day, the Billing page, builds and reviews metered | [Chapter 14](/book/14-metering-and-billing) |

Stores, a second kind of storage attached to a scope, are introduced in chapter 2, and the
glossary in chapter 1 gains the door, plugin, delegated call, store and request id. Chapter 11
covers a sweep that reports a failure once rather than every pass, and chapter 15 adds
symptoms for the new failure shapes and refreshes what is not solved.

One subject is deliberately left open. What an author writes for a module and for a vertical
is already close, and the platform may not keep two words for it. Chapter 8 describes the
boundary as it is built today, and names the property any future shape has to keep: code
someone else wrote runs in its own deployment.

## A note on honesty

Substrat is 0.x. Several things in this book are described as built because they are,
and a few are described as not built because they are not. Where a mechanism has a known
gap, the chapter says so in the place you would otherwise assume it was covered, rather
than in a footnote. [What Substrat doesn't have (yet)](/guide/what-substrat-lacks) is the
concentrated version of that.
