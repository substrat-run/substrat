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
 * means the plugin distribution (#753) ships this script unchanged rather than
 * forking it: `plugin/substrat/scripts/session-start.mjs` is emitted from this
 * file byte-for-byte, and `pnpm lint:plugin --check` fails if the two diverge.
 *
 * The plugin copy is what reaches a project scaffolded before this hook existed.
 * When a project owns its own copy, the plugin's stays silent — see
 * `isPluginCopy()` below — so a scaffolded project announces itself once.
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
import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = 'https://substrat.net';
const KERNEL = '@substrat-run/kernel';

/** Where the project is. Claude Code sets this; fall back to the cwd it ran us in. */
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/** Where this script is. The two copies differ only in where they sit on disk. */
const self = fileURLToPath(import.meta.url);

/** Symlinks resolved, so a project reached through one is not mistaken for elsewhere. */
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when we are the plugin's copy rather than the project's own.
 *
 * Asked positionally instead of by a flag, because the two copies must stay
 * byte-identical for `lint:plugin` to have anything to check: a copy that is
 * invoked differently is a copy that can be edited differently. Both sides are
 * resolved first — on macOS a project under `/tmp` is handed to us as
 * `/private/tmp`, and an unresolved compare would read the project's own copy as
 * foreign and silence the very hook that should speak.
 */
function isPluginCopy() {
  const inside = relative(real(root), real(self));
  return inside.startsWith('..') || isAbsolute(inside);
}

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

  // The project's own copy wins. It ships beside the playbook it points at, so it
  // is the one that matches what is actually checked out here; the plugin's exists
  // for projects scaffolded before this hook did, and must not double-announce.
  if (isPluginCopy() && existsSync(join(root, '.substrat', 'hooks', 'session-start.mjs'))) silent();

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
