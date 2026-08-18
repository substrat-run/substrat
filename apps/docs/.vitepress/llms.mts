/**
 * The machine-readable docs surface (#751): `llms.txt`, `llms-full.txt`, and a
 * `.md` twin of every page.
 *
 * VitePress serves HTML only, so an agent reading our docs today gets nav
 * chrome, a rendered `::: tip`, and theme markup wrapped around the three
 * paragraphs it wanted. The fix is the one the ecosystem has converged on: an
 * index at a well-known path pointing at *raw markdown*, so the agent fetches
 * prose instead of scraping a page.
 *
 * Three artifacts, each with a different job:
 *
 *   - **`/llms.txt`** — the index. One line per page, grouped by the site's own
 *     sections, each with a one-line description. This is what an agent reads
 *     first to decide *which* page it needs. It is deliberately small.
 *   - **`/llms-full.txt`** — every page concatenated, for one-shot ingestion
 *     into a context window. Large; the index exists so this is the fallback,
 *     not the default.
 *   - **`/concepts/model.md`** and friends — the twin of each page: source
 *     markdown with frontmatter stripped, VitePress containers flattened to
 *     blockquotes, and every internal link rewritten to the twin's own absolute
 *     URL, so an agent that follows a link lands on markdown again rather than
 *     bouncing back into HTML.
 *
 * ## Why this runs in `buildEnd` and not as a script
 *
 * The issue asked for a build plugin so the artifacts cannot drift from the
 * site, and that is the whole point: the index is walked from the same
 * `sidebar.mts` the nav renders from, and the twins are written from the same
 * `srcDir` VitePress just rendered. There is no second list of pages to forget
 * to update. `pnpm lint:llms --check` runs the identical code and asserts the
 * two agree.
 *
 * ## Version pinning, honestly
 *
 * Wasp partitions its index by framework version and keeps an archive per
 * version. We cannot copy that: a Cloudflare Pages deploy replaces the whole
 * site, so there is no archive to point at, and inventing `llms-0.71.txt` URLs
 * that 404 tomorrow would be worse than not versioning at all.
 *
 * What we do instead: the index states the `@substrat-run/kernel` version it
 * describes, and we emit `/llms-<version>.txt` as an alias for the *current*
 * version only. A hook (#754) that reads the installed kernel version and
 * fetches that URL gets a mechanical answer — 200 means the published docs
 * describe the kernel you actually have, 404 means they have moved on and the
 * agent should re-read `/llms.txt` rather than trust what it cached. At 0.x
 * with interfaces changing without notice, "your docs are for a different
 * kernel" is the failure this has to make visible.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileForLink, tableOfContents, type IndexedPage } from './sidebar.mjs';

/** Where the docs are published. Links in `llms.txt` must be absolute. */
export const SITE = 'https://substrat.net';

/** The one-line site blurb, mirrored from `config.mts`. */
const TAGLINE =
  'The hard parts, hosted. A runtime-enforced substrate for building vertical B2B SaaS.';

/**
 * The version an agent pins to. The kernel is the right choice: it owns the
 * seams every vertical compiles against, so its version moving is what makes a
 * cached page wrong.
 */
export function kernelVersion(repoRoot: string): string {
  const pkg = join(repoRoot, 'packages/kernel/package.json');
  return JSON.parse(readFileSync(pkg, 'utf8')).version as string;
}

/** Strip a leading `---` frontmatter block, returning it and the body. */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { frontmatter: '', body: raw };
  return { frontmatter: match[1], body: raw.slice(match[0].length) };
}

/** A page may name its own index line. Used where the opening prose is a table. */
function frontmatterDescription(frontmatter: string): string | undefined {
  const match = /^description:\s*(.+)$/m.exec(frontmatter);
  if (!match) return undefined;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

/** Markdown emphasis and links, reduced to the words. For one-line descriptions. */
function plainText(markdown: string): string {
  return markdown
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The page's one-line description: its `description` frontmatter, else its
 * first paragraph of actual prose — skipping headings, containers, code,
 * components and tables, all of which describe nothing on their own.
 */
export function describe(raw: string): string {
  const { frontmatter, body } = splitFrontmatter(raw);
  const declared = frontmatterDescription(frontmatter);
  if (declared) return declared;

  let paragraph = '';
  let inFence = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // A blockquote's prose is prose; the marker is not part of it.
    const text = line.replace(/^\s*>\s?/, '');
    if (!text.trim()) {
      if (paragraph) break;
      continue;
    }
    // A table, a list, a container, a heading or a component is not a description.
    if (/^\s*(#|:::|\||[-*+]\s|\d+\.\s|<)/.test(text)) {
      if (paragraph) break;
      continue;
    }
    paragraph += (paragraph ? ' ' : '') + text.trim();
  }

  const text = plainText(paragraph);
  if (!text) return '';

  // One sentence, and never a runaway. Prefer a sentence boundary, then a
  // clause, then a hard cut — an index line that wraps twice is not an index.
  if (text.length <= 200) return text;
  const sentence = text.slice(0, 200).lastIndexOf('. ');
  if (sentence > 80) return text.slice(0, sentence + 1);
  const clause = text.slice(0, 200).lastIndexOf(' — ');
  if (clause > 80) return `${text.slice(0, clause)}…`;
  return `${text.slice(0, text.slice(0, 200).lastIndexOf(' '))}…`;
}

/**
 * Rewrite a site-absolute docs link to its markdown twin's absolute URL, so an
 * agent following a link inside a twin gets markdown rather than HTML.
 * `/concepts/model#events` → `https://substrat.net/concepts/model.md#events`.
 */
function twinUrl(link: string): string {
  const [path, hash] = link.split('#');
  const suffix = hash ? `#${hash}` : '';
  // A link that already names a file — `/llms.txt`, an asset, a page's own twin —
  // is a destination, not a docs route. Absolutize it and leave it alone.
  if (/\.[a-z0-9]+$/i.test(path)) return `${SITE}${path}${suffix}`;
  return `${SITE}/${fileForLink(path)}${suffix}`;
}

/**
 * Source markdown → the twin an agent should read.
 *
 * VitePress containers become blockquotes (the closest markdown has to an
 * aside, and it keeps the label that carries the warning). Theme components
 * become a pointer at the rendered page, because a diagram that only exists as
 * Vue cannot be flattened honestly — better to say so than to drop it silently.
 */
export function toTwin(raw: string): string {
  const { body } = splitFrontmatter(raw);
  const out: string[] = [];
  let inFence = false;
  let inContainer = false;

  /** Inside a container every line carries the blockquote marker, fences included. */
  const push = (line: string) => {
    if (!inContainer) return out.push(line);
    return out.push(line.trim() ? `> ${line}` : '>');
  };

  for (const line of body.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      push(line);
      continue;
    }
    if (inFence) {
      push(line);
      continue;
    }

    if (!inContainer) {
      const open = /^:::+\s*(\w[\w-]*)\s*(.*)$/.exec(line);
      if (open) {
        const [, type, title] = open;
        const label = type.charAt(0).toUpperCase() + type.slice(1);
        out.push('', `> **${label}${title.trim() ? ` — ${title.trim()}` : ''}**`, '>');
        inContainer = true;
        continue;
      }
    } else if (/^:::+\s*$/.test(line)) {
      inContainer = false;
      out.push('');
      continue;
    }

    // A bare theme component renders a diagram we cannot express as markdown.
    const component = /^<([A-Z]\w*)\s*\/>\s*$/.exec(line.trim());
    if (component) {
      push(`*(Diagram: ${component[1]} — rendered at the HTML page for this document.)*`);
      continue;
    }

    push(line);
  }

  // Internal links point at HTML routes; an agent reading markdown wants markdown.
  const linked = out
    .join('\n')
    .replace(/\]\((\/[^)\s]*)\)/g, (_m, link: string) => `](${twinUrl(link)})`);

  return `${collapseBlankRuns(linked).trimEnd()}\n`;
}

/** Three blank lines in a row is an artifact of stripping, not authorial intent. */
function collapseBlankRuns(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

/** The page's H1, for the concatenated file's section headers. */
function titleOf(raw: string, fallback: string): string {
  const { body } = splitFrontmatter(raw);
  const h1 = body.split('\n').find((l) => l.startsWith('# '));
  return h1 ? plainText(h1.slice(2)) : fallback;
}

export interface Artifact {
  /** Path relative to the site root: `llms.txt`, `concepts/model.md`. */
  path: string;
  contents: string;
}

/** The full name of a page in the index: `Work orders › Events`. */
function indexLabel(page: IndexedPage): string {
  return page.group ? `${page.group} › ${page.text}` : page.text;
}

/**
 * Build every artifact from the docs source. Pure: takes the source directory,
 * returns what should be written. `emit` writes them, `--check` compares them.
 */
export function buildArtifacts(srcDir: string, repoRoot: string): Artifact[] {
  const version = kernelVersion(repoRoot);
  const sections = tableOfContents();
  const artifacts: Artifact[] = [];

  const missing: string[] = [];
  const pages = new Map<string, { page: IndexedPage; raw: string }>();
  for (const section of sections) {
    for (const page of section.pages) {
      const file = join(srcDir, page.file);
      if (!existsSync(file)) {
        missing.push(page.file);
        continue;
      }
      pages.set(page.link, { page, raw: readFileSync(file, 'utf8') });
    }
  }
  if (missing.length) {
    throw new Error(
      `The sidebar names ${missing.length} page(s) with no source file:\n  ${missing.join('\n  ')}`,
    );
  }

  // The twins.
  for (const { page, raw } of pages.values()) {
    artifacts.push({ path: page.file, contents: toTwin(raw) });
  }

  // The index.
  const index: string[] = [
    '# Substrat',
    '',
    `> ${TAGLINE}`,
    '',
    'Substrat is a multi-tenant kernel (tenancy, permissions, events, migrations) plus',
    'headless **engines** that own domain invariants and **verticals** that own everything',
    'a user touches. The guarantees are enforced at runtime by the platform, not by',
    'convention in generated code.',
    '',
    '## Before you read',
    '',
    `These docs describe **@substrat-run/kernel ${version}**.`,
    '',
    `Substrat is pre-1.0 and interfaces change without notice, so a page cached from two`,
    `minors ago is the failure mode this file exists to prevent. Check the version you have`,
    '(`npm ls @substrat-run/kernel`, or the `@substrat-run/kernel` entry in your',
    '`package.json`) against the version above.',
    '',
    `- If they match, everything below describes your install.`,
    `- [\`${SITE}/llms-${version}.txt\`](${SITE}/llms-${version}.txt) is this same file, at a version-pinned URL. Fetching`,
    `  \`${SITE}/llms-<your-version>.txt\` returns 200 only while the published docs still`,
    '  describe your kernel; a 404 means they have moved on, and this file is the one to re-read.',
    '',
    'Every link below is **raw markdown**. Fetch those `.md` URLs directly — do not fetch the',
    'HTML page at the same path, which wraps the same prose in navigation and theme markup.',
    '',
    `Everything at once: [\`${SITE}/llms-full.txt\`](${SITE}/llms-full.txt).`,
    '',
  ];

  for (const section of sections) {
    index.push(`## ${section.text}`, '');
    for (const page of section.pages) {
      const { raw } = pages.get(page.link)!;
      const description = describe(raw);
      const url = twinUrl(page.link);
      index.push(`- [${indexLabel(page)}](${url})${description ? `: ${description}` : ''}`);
    }
    index.push('');
  }

  const indexText = `${index.join('\n').trimEnd()}\n`;
  artifacts.push({ path: 'llms.txt', contents: indexText });
  artifacts.push({ path: `llms-${version}.txt`, contents: indexText });

  // The concatenation.
  const full: string[] = [
    '# Substrat — complete documentation',
    '',
    `> ${TAGLINE}`,
    '',
    `Describes **@substrat-run/kernel ${version}**. Index: ${SITE}/llms.txt`,
    '',
  ];
  for (const section of sections) {
    for (const page of section.pages) {
      const { raw } = pages.get(page.link)!;
      full.push('---', '', `# ${indexLabel(page)}`, '', `Source: ${twinUrl(page.link)}`, '');
      // The twin's own H1 would collide with the section header above it.
      const twin = toTwin(raw);
      const h1 = titleOf(raw, page.text);
      full.push(twin.replace(`# ${h1}\n`, '').trimStart(), '');
    }
  }
  artifacts.push({ path: 'llms-full.txt', contents: `${full.join('\n').trimEnd()}\n` });

  return artifacts;
}

/** Write the artifacts into a built site. */
export function emitInto(outDir: string, artifacts: Artifact[]): void {
  for (const artifact of artifacts) {
    const target = resolve(outDir, artifact.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, artifact.contents);
  }
}
