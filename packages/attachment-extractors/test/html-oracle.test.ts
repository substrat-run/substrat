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
 * marker parse5 does not show.** Everything inside `select`, `svg`, `math` and `frameset` counts
 * as hidden here, stricter than a browser, because the extractor indexes nothing there.
 *
 * The converse is held too, as far as the extractor's contract promises it: every marker parse5
 * shows BEFORE the first of those contexts opens must be indexed. From that opener on, the
 * extractor may index less (it suppresses to the context's end, or to the end of the file
 * when it cannot be sure where that is) — under-indexing there is counted, never failed.
 */

interface P5Node {
  nodeName: string;
  value?: string;
  data?: string;
  childNodes?: P5Node[];
  content?: P5Node;
}

/**
 * Elements a browser does not render the content of (scripting on, as parse5 assumes) — and the
 * contexts the extractor does not model, whose content it never indexes.
 */
const HIDDEN = new Set([
  'template', 'script', 'style', 'noscript', 'iframe', 'noembed', 'noframes',
  'select', 'svg', 'math', 'frameset',
]);
/** A token that opens a context the extractor does not model; under-indexing is allowed after it. */
const UNMODELLED = /^<(select|svg|math|frameset)\b/i;

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
  // the contexts the extractor does not model, and what moves a browser in and out of them:
  // a select and what closes it early, foreign content with its integration points, a
  // self-closing root, a text-only annotation, CDATA, a breakout tag, and a frameset
  '<select>', '</select>', '<input>', '<svg>', '</svg>', '<svg/>', '<math>', '</math>',
  '<annotation encoding="text/plain">', '</annotation>', '<foreignObject>', '<desc>', '<mi>',
  '<![CDATA[', ']]>', '<div>', '<b>', '<frameset>',
  // closers that only LOOK like one: a longer name, a suffix
  '</templates>', '</scripture>', '</title-x>', '</textareas>', '</xmpp>', '</style_>',
  // real closers in other spellings: case, whitespace, `/`, an attribute holding a `>`
  '</TEMPLATE >', '</SCRIPT\n>', '</TextArea/>', '</Title x=">">',
];

/** `x000x` … — fixed width, so no marker is a substring of another or of two side by side. */
const marker = (i: number): string => `x${String(i).padStart(3, '0')}x`;

/**
 * `m0 t1 m1 t2 m2 …`: a marker before, between and after the tokens. With `leading: false` the
 * document opens on its first token instead — a browser honours a `<frameset>` only before any
 * text, so that is the only way one is ever in force.
 */
function documentOf(tokens: readonly string[], leading = true): { html: string; markers: string[] } {
  const markers = tokens.map((_, i) => marker(i)).concat(marker(tokens.length));
  if (!leading) markers[0] = '';
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
  /** Markers indexed that parse5 hides — always a failure. */
  leaks: { html: string; leaked: string[] }[];
  /** Markers parse5 shows, missing BEFORE any unmodelled context opened — a failure too. */
  missed: { html: string; missed: string[] }[];
  /** Documents missing a shown marker after an unmodelled opener — allowed, and counted. */
  suppressed: number;
}

async function check(docs: Iterable<readonly string[]>, leading = true): Promise<Tally> {
  const tally: Tally = { documents: 0, leaks: [], missed: [], suppressed: 0 };
  for (const tokens of docs) {
    const { html, markers } = documentOf(tokens, leading);
    const shown = visibleText(html);
    const ours = await ourText(html);
    // Marker i stands before token i, so markers up to the opener's index precede it.
    const opener = tokens.findIndex((t) => UNMODELLED.test(t));
    const strictUpTo = opener < 0 ? markers.length - 1 : opener;
    const real = (m: string) => m !== ''; // the absent leading marker
    const leaked = markers.filter((m) => real(m) && ours.includes(m) && !shown.includes(m));
    const missing = markers.map((m, i) => ({ m, i })).filter(({ m }) => real(m) && shown.includes(m) && !ours.includes(m));
    const missed = missing.filter(({ i }) => i <= strictUpTo).map(({ m }) => m);
    if (leaked.length > 0 && tally.leaks.length < 10) tally.leaks.push({ html, leaked });
    if (missed.length > 0 && tally.missed.length < 10) tally.missed.push({ html, missed });
    if (missing.length > missed.length) tally.suppressed += 1;
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
    const shown = visibleText(
      '<template><textarea></template>x001x</textarea></template>x002x' +
        '<select><title><template>x003x</template></title></select>x004x' +
        '<math><annotation encoding="text/plain">x005x</annotation></math>x006x',
    );
    for (const hidden of ['x001x', 'x003x', 'x005x']) expect(shown).not.toContain(hidden);
    for (const visible of ['x002x', 'x004x', 'x006x']) expect(shown).toContain(visible);
  });

  it(`every document of three tokens (${TOKENS.length ** 3})`, async () => {
    const tally = await check(every(3));
    expect(tally.leaks, JSON.stringify(tally.leaks, null, 1)).toEqual([]);
    expect(tally.missed, JSON.stringify(tally.missed, null, 1)).toEqual([]);
    expect(tally.documents).toBe(TOKENS.length ** 3);
    // The allowance is exercised: some documents do lose text after an unmodelled opener.
    expect(tally.suppressed).toBeGreaterThan(0);
  }, 300_000);

  it(`every document of two tokens that OPENS on its first one (${TOKENS.length ** 2}): framesets in force`, async () => {
    const tally = await check(every(2), false);
    expect(tally.leaks, JSON.stringify(tally.leaks, null, 1)).toEqual([]);
    expect(tally.missed, JSON.stringify(tally.missed, null, 1)).toEqual([]);
    expect(tally.documents).toBe(TOKENS.length ** 2);
  });

  it('a seeded sample of 50 000 documents of four to eight tokens', async () => {
    const tally = await check(sampled(50_000, 1575));
    expect(tally.leaks, JSON.stringify(tally.leaks, null, 1)).toEqual([]);
    expect(tally.missed, JSON.stringify(tally.missed, null, 1)).toEqual([]);
  }, 300_000);
});
