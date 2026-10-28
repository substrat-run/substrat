import { HTTPException } from 'hono/http-exception';
import { redactDocument } from './explain.js';

/** Sections of the published snapshot, not files from a repository. Headings in fences are data. */
export function conceptSections(markdown: string): Array<{ id: string; title: string; text: string }> {
  const sections: Array<{ id: string; title: string; text: string }> = [];
  let title = 'Overview';
  let lines: string[] = [];
  let fence: { char: string; length: number } | undefined;
  const flush = () => {
    const text = lines.join('\n').trim();
    if (text || sections.length > 0 || title !== 'Overview') sections.push({ id: `s${sections.length}`, title, text });
    lines = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
    } else if (marker) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
    } else {
      const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        flush();
        title = Array.from(heading[1]!).slice(0, 200).join('');
        continue;
      }
    }
    lines.push(line);
  }
  flush();
  return sections;
}

/** Each fragment fits Ask's string bound; the full page fits its UTF-8 tool-output bound. */
function fragments(text: string): string[] {
  const out: string[] = [];
  const encoder = new TextEncoder();
  for (const paragraph of text.split(/\n\s*\n/).filter(Boolean)) {
    let fragment = '';
    let bytes = 0;
    for (const char of paragraph) {
      const size = encoder.encode(char).byteLength;
      if (bytes + size > 500) {
        out.push(fragment);
        fragment = '';
        bytes = 0;
      }
      fragment += char;
      bytes += size;
    }
    if (fragment) out.push(fragment);
  }
  return out;
}

/** Index first, then a bounded page of one section. Offsets address fragments in that snapshot. */
export function conceptPage(markdown: string, section?: string, offset = 0) {
  // Redact before splitting: a token or PEM block may straddle a fragment or section.
  const sections = conceptSections(redactDocument(markdown));
  const index = sections.map(({ id, title }) => ({ id, title }));
  if (section === undefined) {
    const page = index.slice(offset, offset + 20);
    return { sections: page, section: null, nextOffset: offset + page.length < index.length ? offset + page.length : null };
  }
  const found = sections.find((s) => s.id === section);
  if (!found) throw new HTTPException(404, { message: 'application description section not found' });
  const all = fragments(found.text);
  const paragraphs = all.slice(offset, offset + 20);
  return {
    sections: [],
    section: { id: found.id, title: found.title, paragraphs },
    nextOffset: offset + paragraphs.length < all.length ? offset + paragraphs.length : null,
  };
}
