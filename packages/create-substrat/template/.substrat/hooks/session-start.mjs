#!/usr/bin/env node
/**
 * SessionStart hook — the project announces itself (#754).
 *
 * The smooth part of a framework's agent integration is not the skills, it is
 * that the user never has to remember the framework *has* an integration. This
 * runs when an agent session starts, and if the project is a Substrat vertical
 * it hands the agent three things it would otherwise have to discover: what this
 * project is, where the rules live, and **which version of the docs describes the
 * kernel actually installed here**.
 *
 * That last one is the reason this exists. Substrat is 0.x and interfaces change
 * without notice, so an agent working from pages it cached two minors ago is the
 * expensive failure — confident, plausible, and wrong. `llms.txt` is published at
 * a version-pinned URL precisely so this hook can point at the matching slice.
 *
 * ## Deliberately not tool-specific
 *
 * This file lives in `.substrat/` — the tool-neutral home, next to `playbook.md` —
 * not in `.claude/`. `.claude/settings.json` is a three-line adapter that runs it,
 * and any other client that grows a session hook binds the same way. It also
 * means the plugin distribution (#753) can ship this script unchanged rather than
 * forking it.
 *
 * ## Deliberately silent, and deliberately offline
 *
 * It prints nothing at all unless `package.json` has a `substrat` block, so it is
 * inert in any other project. And it makes **no network request**: session start
 * is on the critical path of every session and is frequently offline, while the
 * check a fetch would perform — does the published doc set still describe my
 * kernel — is already mechanical for whoever actually fetches, because
 * `/llms-<version>.txt` 404s exactly when the answer is no.
 *
 * Opt out by creating `.substrat/no-session-context`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DOCS = 'https://substrat.net';
const KERNEL = '@substrat-run/kernel';

/** Where the project is. Claude Code sets this; fall back to the cwd it ran us in. */
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/** The marker: which kernel version this project last announced. */
const MARKER = join(root, '.substrat', '.docs-pin');
const OPT_OUT = join(root, '.substrat', 'no-session-context');

/** Nothing this hook does is worth failing a session over. */
function silent() {
  process.exit(0);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function main() {
  if (existsSync(OPT_OUT)) silent();

  const pkg = readJson(join(root, 'package.json'));
  // The detection signal is the block `substrat push` already reads — no sentinel
  // file to invent, and nothing to keep in sync.
  if (!pkg?.substrat) silent();

  if (existsSync(OPT_OUT)) silent();

  // What is actually installed beats what package.json asked for: a caret range on
  // 0.x pins the minor, and the resolved version is what the code compiles against.
  const installed = readJson(join(root, 'node_modules', KERNEL, 'package.json'))?.version;
  const declared = pkg.dependencies?.[KERNEL] ?? pkg.devDependencies?.[KERNEL];

  const lines = [
    'This project is a **Substrat vertical** — a multi-tenant business app on the',
    'Substrat kernel and its engines.',
    '',
    '- The always-on rules you must not violate are in `AGENTS.md` — module-code',
    '  boundaries, the gates, and the two checkpoints you may never self-approve.',
    '- The build flow (interview → design → reshape → checkpoints) is `.substrat/playbook.md`.',
    '  It is a playbook, not always-on context: read it when starting or extending a vertical.',
  ];

  if (installed) {
    lines.push(
      '',
      `This project has **${KERNEL} ${installed}** installed.`,
      '',
      `Docs describing that exact version: ${DOCS}/llms-${installed}.txt`,
      '',
      'That URL returns 200 only while the published docs still describe this kernel. A 404',
      `means they have moved on — fetch ${DOCS}/llms.txt instead, and treat anything you`,
      'already believe about the API as unverified. Substrat is pre-1.0 and interfaces change',
      'without notice, so do not answer from memory about its surface; the pages are markdown',
      'at those URLs and every doc page has a `.md` twin.',
    );

    const announced = existsSync(MARKER) ? readFileSync(MARKER, 'utf8').trim() : '';
    if (announced && announced !== installed) {
      lines.unshift(
        `**The kernel moved: ${announced} → ${installed} since the last session here.**`,
        'Re-read the docs slice below before relying on anything you remember about the API.',
        '',
      );
    }
    try {
      mkdirSync(dirname(MARKER), { recursive: true });
      writeFileSync(MARKER, `${installed}\n`);
    } catch {
      // A read-only checkout still gets the context; it just re-announces next time.
    }
  } else {
    lines.push(
      '',
      `**${KERNEL} is not installed yet** (\`package.json\` asks for \`${declared ?? 'it'}\`).`,
      'Run the install before trusting any version-specific guidance, then re-check the docs',
      `index at ${DOCS}/llms.txt.`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: lines.join('\n'),
      },
    })}\n`,
  );
}

try {
  main();
} catch {
  // Never break a session because orientation failed.
  silent();
}
