---
name: weekly-changelog
description: Write the week's entry for the published changelog at apps/docs/changelog/ and open a PR with it. Use on Monday mornings, or whenever asked to write, refresh or backfill a weekly changelog / digest / "what shipped" entry for substrat.net.
---

# The weekly changelog

Every Monday, `apps/docs/changelog/` gains one page for the week that just ended.
It is published at [substrat.net/changelog](https://substrat.net/changelog/) and read by
people building on Substrat — not by the people who wrote the PRs.

Your output is a **pull request**, never a push to `main`. The prose is the product; a
human reads it before it publishes.

## 1. Get the raw material

```bash
node tools/changelog-week.mjs              # the last complete week
node tools/changelog-week.mjs --week 2026-w34
```

That prints every first-parent merge grouped by area, the commits that landed without a
PR, and the version span each released package covered. It is the *input*, not a draft —
do not paste it into the page.

Read the PR bodies for anything you intend to make a highlight:

```bash
gh pr view 784 --json title,body -q '.title, .body'
```

The bodies are where the *why* lives. A subject line tells you what changed; the body
tells you what was broken before, which is what the reader actually needs.

## 2. Find the week's argument

A week is 90–130 merges. They are never 90 unrelated things — three or four threads run
through them, and naming the threads is the whole job. Week 34's was "a second description
of a declared thing drifts, and nothing was checking", and two-thirds of the merges were
that one sentence playing out across contracts, engines, demos and the emitters.

Open with that in two or three sentences. If you cannot find an argument, say what the
week was instead — cleanup, hardening, one big landing — rather than manufacturing one.

## 3. Write it

Frontmatter, exactly:

```yaml
---
title: Week 34, 2026
description: <60–200 chars, no trailing colon — this becomes the llms.txt index line>
range: 2026-08-17..2026-08-24   # Monday to Monday, end exclusive
---
```

The filename is the ISO week: `2026-w34.md`. `lint:changelog --check` verifies the
filename and the range agree, so a mistyped week fails rather than silently covering the
wrong days.

Then:

- **A lede.** The argument, and the count of merges.
- **Four to six highlights**, `##` each, in descending order of how much they change
  the way someone writes a vertical. A highlight is a *paragraph or three*, not a bullet:
  what it is, what was wrong before, and what it costs the reader. Show code when the
  seam is an API (`ctx.atomic`, `ctx.now()`). Say **"this will break existing code"**
  plainly when it will — Substrat is pre-1.0 and phrasing a break as a feature is the one
  thing that makes this page not worth reading.
- **`## Also landed`** — everything else, grouped into bold-led paragraphs by area
  (platform, connectors, scaffolding, builder, docs). One clause per PR, rewritten into
  something a reader outside the repo can parse. Not a bullet list of commit subjects.
- **`## Released`** — the table of version spans from the tool. Name any package that is
  new this week.
- **Link definitions at the bottom**: `[#784]: https://github.com/substrat-run/substrat/pull/784`.
  Reference-style, so the prose stays readable in the source. An issue number cited for
  context links to `/issues/`, not `/pull/`.

### Voice

Match the repo. Present tense, lowercase declarative headlines, the subject is the thing
rather than the team — "module code lost the wall clock", not "we removed Date.now()".
No superlatives, no "we're excited to". A change that found a bug in our own reference
implementation says so; that is the interesting part, not an embarrassment.

Nothing about customers, tenants by name, or unreleased commercial plans reaches this
page. It is public.

## 4. Check it

```bash
pnpm lint:changelog --check   # every merge in the range is cited somewhere on the page
pnpm lint:llms --check        # the entry is indexed and its description is usable
pnpm docs:build               # the sidebar picks it up from the directory
```

`lint:changelog` failing with *"N of M merges are not accounted for"* is the normal
outcome of a first draft. Fold the missing ones into `Also landed` — the rule is that
every merge is *accounted for*, not that every merge is interesting.

The three commits a week that land without a PR cannot be cited and are reported as a
note, not a failure. Cover them in prose anyway.

## 5. Open the PR

Branch `changelog/2026-w34`, one commit, subject `docs(changelog): week 34, 2026`. The PR
body is the lede plus the list of highlight titles — enough for a reviewer to see the
shape without opening the diff.

Do not merge it.
