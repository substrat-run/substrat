---
name: weekly-changelog
description: Write the week's entry for the published changelog at apps/docs/changelog/ and open a PR with it. Use on Monday mornings, or whenever asked to write, refresh or backfill a weekly changelog / digest / "what shipped" entry for substrat.net.
---

# The weekly changelog

Every Monday, `apps/docs/changelog/` gains one page for the week that just ended.
It is published at [substrat.net/changelog](https://substrat.net/changelog/) and read by
**people building on Substrat or operating a hosted vertical** — not by the people who
wrote the PRs. It answers one question for that reader: *what changed for me?*

Your output is a **pull request**, never a push to `main`. The prose is the product; a
human reads it before it publishes. `apps/docs/changelog/2026-w35.md` is the reference
entry — read it before writing.

## 1. Get the raw material

```bash
node tools/changelog-week.mjs              # the last complete week
node tools/changelog-week.mjs --week 2026-w35
```

That prints every first-parent merge grouped by area, the commits that landed without a
PR, and the version span each released package covered. It is the *input*, not a draft —
nothing in it is pasted into the page.

Read the PR bodies for anything you intend to make a section:

```bash
gh pr view 910 --json title,body -q '.title, .body'
```

The bodies are where the *why* lives. A subject line tells you what changed; the body
tells you what was broken before — and what a reader has to do now, which is what the
page is for.

## 2. Triage every merge by what the reader can do now

For each merge, decide which of these it is, from the reader's side:

- **A new capability** — something a vertical can now declare, call, read, send, or
  configure (a header, a `ctx` function, an operation option, a console screen, a CLI
  flag).
- **A change in behaviour** — a call that used to succeed now fails, a lint that goes
  red on existing code, a default that flipped, a field that moved.
- **A new or improved demo** — a new vertical, or an existing one gaining something a
  reader can try.
- **An operator concern** — anything someone running a hosted instance must know or do
  (a security fix, a window that closed, a link to mint).
- **Internal** — tooling, CI, tests, refactors, console chrome, the repo's own docs
  plumbing. These are accounted for (§5) and otherwise get at most one clause in *Also*,
  or nothing.

Group what survives by **what the reader gains**, not by package or by PR. Five merges
that together make retries safe are one section, "Safe retries"; one merge that touched
eleven packages is still one sentence if the reader sees one thing.

## 3. Write it

Frontmatter, exactly:

```yaml
---
title: Week 35, 2026
description: <60–200 chars, no trailing colon — this becomes the llms.txt index line>
range: 2026-08-24..2026-08-31   # Monday to Monday, end exclusive
---
```

The filename is the ISO week: `2026-w35.md`. `lint:changelog --check` verifies the
filename and the range agree, so a mistyped week fails rather than silently covering the
wrong days.

Then:

- **A lede** of four or five sentences saying what changed for the reader this week,
  in plain words. Not the repo's internal argument, not a count of merges, not a theme
  the reader has to decode.
- **Sections, `##` each**, named for what the reader can now do or must now know —
  *Errors are structured now*, *Safe retries, and no more lost updates*, *A new demo:
  ticket0, an AI support desk*, *For hosted operators: the owner seat*. In descending
  order of how much they change how someone writes or runs a vertical. A section is a
  paragraph or three: what it is, what was wrong before, what to do. Code is the one
  line a reader would type — a header, a declaration, an embed tag — never a diff, a
  table of packages, or an internal API.
- **Say plainly when behaviour changes.** Bold it, at the top of the section it belongs
  to: *One thing changes behaviour.* / *A new lint rule will flag existing code.* Substrat
  is pre-1.0; phrasing a break as a feature is the one thing that makes this page not
  worth reading.
- **Demos get their own section** when one is new or gained something a reader can try:
  what it is, where to try it, the one idea it exists to show, what improved.
- **`## Also`** — the remaining reader-visible changes as short bullets by area
  (issuer, deploying, UI kit, docs). One clause each, rewritten so someone outside the
  repo can parse it. Internal work does not appear here.
- **`## Released`** — the table of version spans from the tool. Name any package that is
  new this week.

### What is not on the page

- **No pull-request or issue numbers, links, or `#NNN` in the prose.** The reader has no
  reason to open the repo; a reference tells them nothing about what they can do.
- No package names in section headings; no commit subjects; no "we".
- No merge counts, no "argument of the week", nothing about how the sausage was made.
- Nothing about customers, tenants by name, or unreleased commercial plans. It is public.

### Voice

Present tense, second person where natural ("send an `Idempotency-Key` on any write"),
lowercase declarative headlines, the subject is the thing rather than the team — "errors
are structured now", not "we shipped problem+json". No superlatives, no "we're excited
to". A change that found a bug in our own demo says so; that is useful, not embarrassing.

## 4. Account for every merge — in a comment

Completeness is mechanical and stays so. `pnpm lint:changelog --check` reads every
merged PR inside the entry's `range` and fails unless each number appears **somewhere in
the file's source** — it does not care where. So the prose cites nothing, and the file
ends with a **coverage ledger inside an HTML comment**, grouped by the section that
covers each PR:

```html
<!--
Coverage ledger — not rendered. `pnpm lint:changelog --check` reads the merged
pull requests inside this entry's range and fails if any is not named on this
page, so the page cannot quietly omit a week's work. The prose above is written
for someone building on the platform and cites none of them; this is where they
are accounted for.

Errors, retries, lost updates:   #910 #903 #902 #908 #904 #906
ticket0:                         #918 #922 #926 #932 #919
Internal (not on the page):      #950 #941
Without a PR: <one line per commit the tool listed as uncitable>
-->
```

The ledger is for the reviewer and the gate. Grouping it by section is what makes a
reviewer able to check that a PR under "ticket0" is actually described in that
section; a flat list would pass the gate and prove nothing. A PR you decided is
internal goes under *Internal* so the decision is visible, not silent.

The commits that land without a PR cannot be cited and are reported as a note, not a
failure. Name them in the ledger anyway, and cover them in prose if a reader would see
them.

## 5. Check it

```bash
pnpm lint:changelog --check   # every merge in the range is in the ledger
pnpm lint:llms --check        # the entry is indexed and its description is usable
pnpm docs:build               # the sidebar and nav pick it up from the directory
```

Then confirm nothing leaked: what the reader sees must contain no `#NNN` and no link
to a pull request or issue. Check the page's markdown twin (what `llms.txt` serves)
with the ledger comment stripped — not the raw HTML, where CSS colours (`#005`) and
asset hashes match a `#NNN` grep. Set the week once and reuse it below.

```bash
WEEK=2026-w35   # the entry you are checking
sed '/<!--/,/-->/d' "apps/docs/.vitepress/dist/changelog/$WEEK.md" \
  | grep -oE '#[0-9]{3,}|/(pull|issues)/[0-9]+' | sort -u
# expect: nothing (the ledger is the only place a number lives, and it was stripped)
```

`lint:changelog` failing with *"N of M merges are not accounted for"* is the normal
outcome of a first draft. Add the missing ones to the ledger under the section that
covers them — and if none does, decide whether they are *Internal* or a paragraph you
forgot.

## 6. Open the PR

Branch `changelog/$WEEK` (`changelog/2026-w35`), one commit, subject
`docs(changelog): week <N>, <YYYY>` (`docs(changelog): week 35, 2026`). The PR
body is the lede plus the section titles — enough for a reviewer to see the shape without
opening the diff — and a note of which sections carry a *changes behaviour* flag.

**Never open it before the week has ended.** The gate asserts every merge inside the
range is accounted for, so an entry merged mid-week goes red on the first merge that
lands after it was written. If you are asked for a mid-week draft, open it as a **draft
PR** and say in the body that it is refreshed on Monday before merge.

Do not merge it.
