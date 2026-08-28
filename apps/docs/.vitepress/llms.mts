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
import { dirname, extname, join, resolve } from 'node:path';
import { fileForLink, START_HERE, tableOfContents, type IndexedPage } from './sidebar.mjs';
import { altFor } from './theme/components/alt.mjs';

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
 * A component on a line of its own: `<LayerStack />`, `<StateMachine engine="booking" />`.
 *
 * Props are part of the match because one component can serve many pages — the
 * five engine state machines are one component and five props. `tools/llms-index.mts`
 * matches with the same pattern, so a page it passes is a page this can flatten.
 */
export const COMPONENT_LINE = /^<([A-Z]\w*)((?:\s+[a-z][\w-]*="[^"]*")*)\s*\/>$/;

/** `engine="booking"` → `{ engine: 'booking' }`. String props only, by design. */
export function propsOf(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, k, v] of attrs.matchAll(/([a-z][\w-]*)="([^"]*)"/g)) out[k] = v;
  return out;
}

/**
 * Source markdown → the twin an agent should read.
 *
 * VitePress containers become blockquotes (the closest markdown has to an
 * aside, and it keeps the label that carries the warning). Theme components are
 * flattened by `altFor` when they carry prose — which both of ours do, out of
 * plain arrays — and fall back to a pointer at the rendered page only when there
 * is genuinely nothing to flatten.
 */
export function toTwin(raw: string, srcDir?: string): string {
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

    // A file the page pulls in at build time. The rendered page resolves it; the
    // twin has to as well, or a walkthrough that exists to show whole files hands
    // an agent a page of pointers.
    const pulled = pulledIn(line, srcDir);
    if (pulled) {
      for (const l of pulled) push(l);
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

    // A theme component on a line of its own, with or without simple string
    // props. Its content is markdown when the component keeps it in a content
    // module; a pointer at the page when it does not.
    const component = COMPONENT_LINE.exec(line.trim());
    if (component) {
      const flattened = altFor(component[1], propsOf(component[2] ?? ''));
      push(
        flattened ??
          `*(Diagram: ${component[1]} — rendered at the HTML page for this document.)*`,
      );
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

/**
 * VitePress's snippet import, in full: `<<< path[#region][{meta}] [title]`, where
 * `meta` is any of line highlights, a language, `:line-numbers` — `{1,3-5 ts:line-numbers}`.
 */
const SNIPPET = /^<<<\s*(\S+?)(#[\w*-]+)?(?:\{([^}]*)\})?(?:\s+\[[^\]]*\])?\s*$/;
/**
 * VitePress's markdown include, in full: `<!--@include: path[#region][{from,to}]-->`,
 * the range 1-based and either end open.
 */
const INCLUDE = /^<!--@include:\s*(\S+?)(#[\w-]+)?(?:\{(\d*),(\d*)\})?\s*-->$/;

/**
 * The lines a snippet or include stands for (#741), or `undefined` for any other
 * line. `@/` is the docs source directory, exactly as VitePress resolves it, so
 * a walkthrough pulling `@/../../demos/todo/spec/model.ts` into the page pulls
 * the same file into the twin. A snippet becomes a fence tagged by its explicit
 * language or else its extension; an include is spliced in as the markdown it
 * is, honouring the line range.
 *
 * What the rendered page can do and the twin does not, the twin **refuses**
 * rather than approximates: a `#region` selector (VitePress's marker grammar is
 * not worth a second implementation), a path relative to the page rather than
 * `@/` (this function does not know the page), or a directive it cannot parse
 * at all. Reading the whole file where the page shows a region would hand an
 * agent a twin that quietly differs from the page, and this runs under
 * `lint:llms --check`, so the refusal is a red PR rather than a wrong artifact.
 * Line highlights and line numbers are presentation and are dropped on purpose.
 *
 * Without a source directory (a caller with only the text) the line is kept as
 * written, which is what the twin did before and is still the honest fallback.
 */
function pulledIn(line: string, srcDir: string | undefined): string[] | undefined {
  if (!srcDir) return undefined;
  const directive = line.trim();
  const isSnippet = directive.startsWith('<<<');
  const isInclude = directive.startsWith('<!--@include:');
  if (!isSnippet && !isInclude) return undefined;

  const refuse = (why: string): never => {
    throw new Error(
      `The llms twin cannot reproduce \`${directive}\`: ${why}.\n` +
        `Supported: \`<<< @/path[{lang}]\` and \`<!--@include: @/path[{from,to}]-->\`.`,
    );
  };
  const fileOf = (path: string, region: string | undefined): string => {
    if (region) refuse(`\`${region}\` selects a region, and the twin pulls whole files or line ranges only`);
    if (!path.startsWith('@/')) refuse('the path must be `@/…`, relative to the docs source directory');
    return resolve(srcDir, path.slice(2));
  };

  if (isSnippet) {
    const snippet = SNIPPET.exec(directive);
    if (!snippet) refuse('it is not a snippet import the twin can parse');
    const [, path, region, meta] = snippet!;
    const file = fileOf(path!, region);
    const lang = languageOf(meta) ?? extname(file).slice(1);
    return [`\`\`\`${lang}`, readFileSync(file, 'utf8').trimEnd(), '```'];
  }

  const include = INCLUDE.exec(directive);
  if (!include) refuse('it is not a markdown include the twin can parse');
  const [, path, region, fromText, toText] = include!;
  const lines = readFileSync(fileOf(path!, region), 'utf8').trimEnd().split('\n');
  const from = fromText ? Number(fromText) : 1;
  const to = toText ? Number(toText) : lines.length;
  return lines.slice(from - 1, to);
}

/**
 * The language a snippet's `{meta}` names, if any: the token that is not a line
 * highlight (`1,3-5`), shorn of its `:line-numbers` flag — `{2 ts:line-numbers}`
 * is `ts`. VitePress falls back to the extension when there is none; so do we.
 */
function languageOf(meta: string | undefined): string | undefined {
  if (!meta) return undefined;
  const word = meta
    .split(/\s+/)
    .filter(Boolean)
    .find((token) => !/^[\d,-]+$/.test(token));
  const lang = word?.replace(/:(?:no-)?line-numbers(?:=\d+)?$/, '');
  return lang || undefined;
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
  // The index promotes this page above everything else it lists, so a rename that
  // left the promotion behind would publish a 404 as the first thing an agent reads.
  if (!pages.has(START_HERE)) {
    throw new Error(
      `llms.txt promotes ${START_HERE} as the page to read first, but no sidebar entry ` +
        `points there. Update START_HERE in sidebar.mts, or restore the page.`,
    );
  }

  // The twins.
  for (const { page, raw } of pages.values()) {
    artifacts.push({ path: page.file, contents: toTwin(raw, srcDir) });
  }

  // The index.
  const index: string[] = [
    '# Substrat',
    '',
    `> ${TAGLINE}`,
    '',
    '## What Substrat is',
    '',
    'Substrat hosts the parts of a business application that are catastrophic to get wrong —',
    'multi-tenancy, permissions, audit, migrations — and enforces them **at runtime**, in the',
    'platform. That is the whole distinction: a template hands you correct code once and every',
    'edit after erodes it, whereas here a vertical *cannot* query across tenants or skip a',
    'permission check, because the kernel will not serve the query.',
    '',
    'Three layers, and you write only the third:',
    '',
    '- **Kernel** — tenancy, permissions, events and audit, migrations. One **scope** is one',
    '  isolated SQLite database; there is no cross-tenant API to misuse.',
    '- **Engines** — headless, versioned packages owning domain invariants (work orders,',
    '  invoicing, bookings, protocols, invites, absence, metering). You either **compose** one',
    '  (import it; its in-scope functions run inside *your* transaction) or **feed** one (emit a',
    '  fat event; it consumes, with no import). Engines never import each other.',
    '- **Verticals** — the application: vocabulary, pricing, roles, screens. This is the layer',
    '  you own, and the only one an agent should be writing.',
    '',
    'A vertical is built by scaffolding one (`npm create substrat`) and reshaping the working',
    'reference vertical it ships into your domain. It runs locally against SQLite with no',
    'platform in the loop, and deploys to Cloudflare Durable Objects unchanged.',
    '',
    'That vocabulary — scope, engine, vertical, module, operation — is what the page titles',
    'below assume you already have.',
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
    '## Start here',
    '',
    'If you are building on Substrat, read this one page before any other:',
    '',
    `- [**Agent rules**](${twinUrl(START_HERE)}): the always-on contract — the three layers,`,
    '  the ten non-negotiable module-code rules, the gates to run, and the two checkpoints you',
    '  may never self-approve. Most of what a generated vertical gets wrong is on that page,',
    '  and where it restates the summary above, that page is the authoritative one.',
    '',
    'The rest of this index is reference. Fetch from it as the task needs, rather than reading',
    'it through — the sections below are ordered for a person learning the platform, not for an',
    'agent with a job to do.',
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
      const twin = toTwin(raw, srcDir);
      const h1 = titleOf(raw, page.text);
      full.push(twin.replace(`# ${h1}\n`, '').trimStart(), '');
    }
  }
  artifacts.push({ path: 'llms-full.txt', contents: `${full.join('\n').trimEnd()}\n` });

  // The plugin marketplace catalog (#753), served from the site root so
  // `claude plugin marketplace add https://substrat.net/marketplace.json` fetches
  // one small file instead of cloning the monorepo. Copied rather than authored
  // here: `.claude-plugin/marketplace.json` in the repo root is the single source,
  // and it has to stay there for `claude plugin marketplace add substrat-run/substrat`
  // to resolve as well. Two published entry points, one file under review.
  const catalog = join(repoRoot, '.claude-plugin', 'marketplace.json');
  if (!existsSync(catalog)) {
    throw new Error(
      `The plugin marketplace catalog is missing: ${catalog}\n` +
        `Users install the Substrat plugin from it; publishing the site without it ` +
        `breaks \`claude plugin marketplace add https://substrat.net/marketplace.json\`.`,
    );
  }
  artifacts.push({ path: 'marketplace.json', contents: readFileSync(catalog, 'utf8') });

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
