import { describe, expect, it } from 'vitest';
import { parse } from 'parse5';
import { htmlExtractor } from '../src/index.js';

/**
 * parse5 as a differential ORACLE for the HTML extractor's hand-written scanner.
 *
 * parse5 implements the HTML standard's tokenizer and tree builder, so where it places a piece
 * of text is where a browser does. Each generated document interleaves tags with unique
 * markers; a marker parse5 puts in a visible text node is visible, and one it puts anywhere
 * else — inside `template`, `script`, `style` or another element a browser hides, in a
 * comment, in an attribute — is not. The property held: **the extractor never indexes a
 * marker parse5 does not show.** It may index less (the scanner does not model SVG, MathML or
 * framesets, none of which these documents contain), so the converse is reported, not held —
 * and it is measured, so a regression that hides visible text shows up in the count.
 */

interface P5Node {
  nodeName: string;
  value?: string;
  data?: string;
  childNodes?: P5Node[];
  content?: P5Node;
}

/** Elements a browser does not render the content of (scripting on, as parse5 assumes). */
const HIDDEN = new Set(['template', 'script', 'style', 'noscript', 'iframe', 'noembed', 'noframes']);

/** All text parse5 shows, joined: every text node with no hidden ancestor. */
function visibleText(html: string): string {
  const out: string[] = [];
  const walk = (node: P5Node, hidden: boolean): void => {
    if (node.nodeName === '#text' && !hidden) out.push(node.value ?? '');
    const inside = hidden || HIDDEN.has(node.nodeName);
    for (const child of node.childNodes ?? []) walk(child, inside);
    if (node.content) walk(node.content, true); // a template's content fragment
  };
  walk(parse(html) as unknown as P5Node, false);
  return out.join('\u0000');
}

const extractor = htmlExtractor();
const signal = new AbortController().signal;
async function ourText(html: string): Promise<string> {
  const r = await extractor.extract({
    body: new TextEncoder().encode(html),
    contentType: 'text/html',
    filename: 'f',
    maxTextBytes: 1024 * 1024,
    signal,
  });
  if ('failed' in r) throw new Error(`extraction failed: ${r.failed}`);
  return r.text;
}

const TOKENS = [
  // openers of every element whose content the tokenizer reads as text, and two that it does not
  '<template>', '<script>', '<style>', '<title>', '<textarea>', '<xmp>', '<noscript>', '<iframe>',
  '<!--', '<p>', '<plaintext>',
  // their real closers
  '</template>', '</script>', '</style>', '</title>', '</textarea>', '</xmp>', '</noscript>',
  '</iframe>', '-->', '</p>',
  // the other ways a comment ends, abrupt and banged
  '<!-->', '--!>',
  // closers that only LOOK like one: a longer name, a suffix
  '</templates>', '</scripture>', '</title-x>', '</textareas>', '</xmpp>', '</style_>',
  // real closers in other spellings: case, whitespace, `/`, an attribute holding a `>`
  '</TEMPLATE >', '</SCRIPT\n>', '</TextArea/>', '</Title x=">">',
];

/** `x000x` … — fixed width, so no marker is a substring of another or of two side by side. */
const marker = (i: number): string => `x${String(i).padStart(3, '0')}x`;

/** `m0 t1 m1 t2 m2 …`: a marker before, between and after the tokens. */
function documentOf(tokens: readonly string[]): { html: string; markers: string[] } {
  const markers = tokens.map((_, i) => marker(i)).concat(marker(tokens.length));
  let html = markers[0]!;
  tokens.forEach((t, i) => {
    html += t + markers[i + 1]!;
  });
  return { html, markers };
}

/** A small deterministic PRNG (mulberry32), so a failing sample reproduces from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Tally {
  documents: number;
  leaks: { html: string; leaked: string[] }[];
  underIndexed: number;
}

async function check(docs: Iterable<readonly string[]>): Promise<Tally> {
  const tally: Tally = { documents: 0, leaks: [], underIndexed: 0 };
  for (const tokens of docs) {
    const { html, markers } = documentOf(tokens);
    const shown = visibleText(html);
    const ours = await ourText(html);
    const leaked = markers.filter((m) => ours.includes(m) && !shown.includes(m));
    if (leaked.length > 0 && tally.leaks.length < 10) tally.leaks.push({ html, leaked });
    if (markers.some((m) => shown.includes(m) && !ours.includes(m))) tally.underIndexed += 1;
    tally.documents += 1;
  }
  return tally;
}

function* every(length: number): Generator<string[]> {
  const idx = new Array<number>(length).fill(0);
  for (;;) {
    yield idx.map((i) => TOKENS[i]!);
    let k = length - 1;
    while (k >= 0 && ++idx[k]! === TOKENS.length) idx[k--] = 0;
    if (k < 0) return;
  }
}

function* sampled(count: number, seed: number): Generator<string[]> {
  const next = prng(seed);
  for (let n = 0; n < count; n += 1) {
    const length = 4 + Math.floor(next() * 5); // 4 to 8 tokens
    yield Array.from({ length }, () => TOKENS[Math.floor(next() * TOKENS.length)]!);
  }
}

describe('the HTML extractor against parse5: nothing a browser hides is ever indexed', () => {
  it('the oracle sees what the reviewed cases claim (its own twin)', () => {
    const shown = visibleText('<template><textarea></template>x001x</textarea></template>x002x');
    expect(shown).not.toContain('x001x');
    expect(shown).toContain('x002x');
  });

  it(`every document of three tokens (${TOKENS.length ** 3})`, async () => {
    const tally = await check(every(3));
    expect(tally.leaks, JSON.stringify(tally.leaks, null, 1)).toEqual([]);
    expect(tally.documents).toBe(TOKENS.length ** 3);
    // Measured, not held: the scanner indexes exactly what parse5 shows on these.
    expect(tally.underIndexed).toBe(0);
  }, 120_000);

  it('a seeded sample of 20 000 documents of four to eight tokens', async () => {
    const tally = await check(sampled(20_000, 1575));
    expect(tally.leaks, JSON.stringify(tally.leaks, null, 1)).toEqual([]);
    expect(tally.underIndexed).toBe(0);
  }, 120_000);
});
