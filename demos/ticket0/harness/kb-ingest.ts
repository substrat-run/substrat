/**
 * The knowledge-base ingester — harness code, and connector-shaped.
 *
 * `ticket0/ingest-kb-source` records the intent and emits `ticket0.kb-ingest-requested`;
 * module code may not fetch, so the fetching happens here, outside the scope's
 * transaction, and the result comes back in through `ticket0/record-kb-articles` — the
 * same authority seam the Scrive connector uses to record a signature back.
 *
 * In a hosted deployment this is a registered connector. On the demo's Node server it
 * is a function the server calls. The operations either end of it are identical.
 */

export interface Article {
  readonly url: string;
  readonly title: string;
  readonly headingPath: string;
  readonly body: string;
}

/**
 * The page a person should be sent to, not the file the corpus was built from.
 *
 * `llms-full.txt` cites the `.md` twin of every page — the machine-readable copy — and
 * a citation is for a HUMAN to check. Sending them to raw markdown is sending them to
 * the working material rather than the documentation.
 */
export function webUrl(source: string): string {
  return source.replace(/\/index\.md$/, '/').replace(/\.md$/, '');
}

/**
 * Parse the `llms-full.txt` shape: one `# Heading` per document, each followed by a
 * `Source: <url>` line and the prose.
 *
 * Documents are split again at `##` so retrieval is granular. A whole documentation
 * page is the wrong unit to cite at somebody — "the answer is somewhere on this page"
 * is what a support desk exists to improve on — and it is also too much text to put in
 * a model's context per hit.
 */
export function parseLlmsFull(text: string): Article[] {
  const out: Article[] = [];
  // Split on top-level headings only: `\n# `, never `\n## `.
  const docs = text.split(/\n(?=# [^#])/g);

  for (const doc of docs) {
    const lines = doc.split('\n');
    const heading = lines[0]?.startsWith('# ') ? lines[0].slice(2).trim() : null;
    if (!heading) continue;

    const sourceLine = lines.find((l) => l.startsWith('Source: '));
    if (!sourceLine) continue;
    const url = webUrl(sourceLine.slice('Source: '.length).trim());
    if (!url) continue;

    // Everything after the Source line, minus the horizontal rules the file uses as
    // document separators.
    const bodyStart = lines.indexOf(sourceLine) + 1;
    const body = lines
      .slice(bodyStart)
      .join('\n')
      .replace(/^\s*---\s*$/gm, '')
      .trim();
    if (!body) continue;

    const sections = body.split(/\n(?=## [^#])/g);
    if (sections.length === 1) {
      out.push({ url, title: heading, headingPath: heading, body: body.slice(0, 8000) });
      continue;
    }

    for (const [i, section] of sections.entries()) {
      const secLines = section.split('\n');
      const secHeading = secLines[0]?.startsWith('## ') ? secLines[0].slice(3).trim() : null;
      const secBody = (secHeading ? secLines.slice(1).join('\n') : section).trim();
      if (secBody.length < 80) continue; // a stub section is noise in an index
      // A section anchor, so a citation lands where the answer actually is.
      const anchor = secHeading
        ? `#${secHeading
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')}`
        : '';
      out.push({
        url: `${url}${anchor}`,
        title: secHeading ? `${heading} — ${secHeading}` : heading,
        headingPath: secHeading ? `${heading} > ${secHeading}` : heading,
        body: secBody.slice(0, 8000),
      });
      if (i === 0 && !secHeading) continue;
    }
  }
  return out;
}

/** The index shape: `- [Title](url): summary` under `## Section` headings. */
export function parseLlmsIndex(text: string): Article[] {
  const out: Article[] = [];
  let section = 'Index';
  for (const line of text.split('\n')) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      section = h[1]!.trim();
      continue;
    }
    const m = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s*:?\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, title, url, summary] = m;
    if (!title || !url || !summary || summary.length < 40) continue;
    out.push({ url: webUrl(url), title, headingPath: `${section} > ${title}`, body: summary });
  }
  return out;
}

export function parseMarkdown(text: string, url: string): Article[] {
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? url;
  return [{ url, title, headingPath: title, body: text.slice(0, 8000) }];
}

/**
 * Fetch a source and turn it into articles.
 *
 * The `llms-txt` kind covers both files in that family: an index of links, and the
 * full corpus. They are told apart by shape rather than by configuration, because a
 * URL ending in `llms.txt` that happens to contain the full text should still work.
 */
export async function fetchArticles(
  kind: 'llms-txt' | 'sitemap' | 'markdown',
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Article[]> {
  const res = await fetchImpl(url, { headers: { accept: 'text/plain, text/markdown, */*' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`);
  const text = await res.text();

  if (kind === 'markdown') return parseMarkdown(text, url);
  if (kind === 'sitemap') throw new Error('sitemap ingestion is not implemented');

  // Full corpus if it carries per-document Source lines; otherwise the link index.
  const full = parseLlmsFull(text);
  if (full.length > 0) return full;
  const index = parseLlmsIndex(text);
  if (index.length > 0) return index;
  throw new Error(`nothing parseable at ${url} — not an llms.txt index or corpus`);
}

export interface IngestTarget {
  invoke<T>(operation: string, input: unknown): Promise<T>;
}

/**
 * Run one ingest, end to end. Returns what changed, or throws with a reason the desk
 * can show on the source — a failed ingest is a health signal, not a silent no-op.
 */
export async function runIngest(
  admin: IngestTarget,
  source: { id: string; kind: 'llms-txt' | 'sitemap' | 'markdown'; url: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ added: number; updated: number; unchanged: number }> {
  const articles = await fetchArticles(source.kind, source.url, fetchImpl);
  // Batched: one operation per few hundred articles keeps a single transaction from
  // holding the scope while thousands of rows are hashed.
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const BATCH = 200;
  for (let i = 0; i < articles.length; i += BATCH) {
    const result = await admin.invoke<{ added: number; updated: number; unchanged: number }>(
      'ticket0/record-kb-articles',
      { sourceId: source.id, articles: articles.slice(i, i + BATCH) },
    );
    added += result.added;
    updated += result.updated;
    unchanged += result.unchanged;
  }
  return { added, updated, unchanged };
}
