#!/usr/bin/env tsx
/**
 * The agent-rules checkpoint — one set of rules, published in two places.
 *
 * `packages/create-substrat/template/AGENTS.md` is the always-on contract a
 * scaffolded vertical carries: the mental model, the ten non-negotiable module-code
 * rules, the gates, and the two things an agent may never self-approve. It is the
 * most operationally useful document we have, and until now it existed *only*
 * inside scaffolded projects — nothing on substrat.net corresponded to it, so an
 * agent pointed at the docs site got the argument for the platform and never
 * reached a rule.
 *
 * This publishes it as `apps/docs/guide/agent-rules.md`, which makes it a page,
 * which gives it a `.md` twin and a line in `llms.txt` (#751). `llms.txt` links it
 * as the one page to read first.
 *
 * ## Why this is a regenerate-and-diff, unlike playbook-sync
 *
 * `playbook-sync` guards two documents that diverge ON PURPOSE, so it can only be a
 * staleness guard on a hash. Here the opposite holds: a rule that reads one way in a
 * scaffolded project and another way on the website is a bug in the worst possible
 * place, because both audiences are agents about to write module code. So the body
 * is copied VERBATIM and re-emitted, exactly as `lint:permissions` and `lint:model`
 * re-emit theirs, and CI fails on any drift.
 *
 * Only the framing differs, and only because it must: AGENTS.md opens by telling a
 * project about itself and links `.substrat/playbook.md` relatively, which resolves
 * to nothing on a website. Everything from the first `## ` heading onward is the
 * source's, untouched.
 *
 *   pnpm lint:agent-rules            re-emit the page
 *   pnpm lint:agent-rules --check    CI: exit 1 if the emitted page has drifted
 *
 * Exit codes follow boundary-lint's: 0 = in sync, 1 = drift, 2 = cannot run.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'packages/create-substrat/template/AGENTS.md';
const TARGET = 'apps/docs/guide/agent-rules.md';

/** The body starts at the first `## ` heading; everything above it is scaffold framing. */
const BODY_STARTS_AT = '\n## ';

const check = process.argv.includes('--check');

/** Exit 2: the tool cannot do its job. Always names the remedy. */
function cannot(message: string): never {
  console.error(`agent-rules: ${message}\n`);
  process.exit(2);
}

if (!existsSync(join(ROOT, SOURCE))) {
  cannot(
    `the source is missing: ${SOURCE}\n` +
      `  This checkpoint publishes that file; without it there is nothing to publish.`,
  );
}

const source = readFileSync(join(ROOT, SOURCE), 'utf8');
const bodyAt = source.indexOf(BODY_STARTS_AT);
if (bodyAt === -1) {
  cannot(
    `${SOURCE} has no \`## \` heading, so the body cannot be found.\n` +
      `  Either the file was restructured or it is no longer the rules document.`,
  );
}
const body = source.slice(bodyAt + 1).trimEnd();

/**
 * The page's own opening. AGENTS.md addresses a project it is sitting inside
 * ("This project is a Substrat vertical") and links the playbook by relative path;
 * neither survives the move to a website. The rules below it do, verbatim.
 */
const PREAMBLE = `---
description: "The always-on contract for building a Substrat vertical: the three layers, the ten non-negotiable module-code rules, the gates to run, and the two checkpoints an agent may never self-approve."
---

# Agent rules

**If you are an agent building on Substrat, this is the page to read first.** It is the
always-on contract — the rules that hold no matter what you touch — and most of what a
generated vertical gets wrong is on this page.

This is not a summary written for the website. It is the exact file
[\`create-substrat\`](/reference/create-substrat) writes into every scaffolded project as
\`AGENTS.md\`, published here so an agent that has not scaffolded anything can still read
it. The two are kept identical mechanically; a rule cannot say one thing in your project
and another thing here.

What this page is *not* is the build flow. Interviewing for a domain, mapping it onto the
engines, and landing a design document a human approves before any code is a **playbook**,
invoked when you start a vertical — \`/substrat\` in Claude Code, the \`new-vertical\`
command in Cursor and opencode. Scaffold first with [Getting started](/guide/getting-started);
this page is what a session already mid-build must never violate.
`;

const emitted = `${PREAMBLE}\n${body}\n`;
const targetPath = join(ROOT, TARGET);
const current = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';

if (check) {
  if (current === emitted) {
    console.log(`agent-rules: ${TARGET} is in sync with ${SOURCE}.`);
    process.exit(0);
  }
  console.error(
    `agent-rules: ${TARGET} has drifted from ${SOURCE}.\n\n` +
      `  The rules are published in two places and must read identically in both.\n` +
      `  Edit the source (${SOURCE}), then run:\n\n` +
      `      pnpm lint:agent-rules\n\n` +
      `  and commit the re-emitted page.\n`,
  );
  process.exit(1);
}

writeFileSync(targetPath, emitted);
console.log(
  current === emitted
    ? `agent-rules: ${TARGET} already in sync.`
    : `agent-rules: wrote ${TARGET} from ${SOURCE}.`,
);
