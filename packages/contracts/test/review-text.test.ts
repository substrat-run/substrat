import { describe, expect, it } from 'vitest';
import { blankReason, clipReviewText, reviewLine, reviewSql, reviewText, REVIEW_TEXT_SHOWN_LINES, REVIEW_TEXT_SHOWN_MAX } from '../src/index.js';

// Every test character is built with String.fromCodePoint, so this file holds none of them raw.
const c = (...points: number[]) => String.fromCodePoint(...points);

describe('reviewText makes every invisible or acting character visible (#2322)', () => {
  const classes: [string, number[]][] = [
    ['ESC', [0x1b]],
    ['the other C0 controls: NUL, BEL, backspace, CR, form feed, vertical tab', [0x00, 0x07, 0x08, 0x0d, 0x0c, 0x0b]],
    ['DEL', [0x7f]],
    ['the C1 controls, CSI among them', [0x80, 0x85, 0x9b, 0x9f]],
    ['the bidi embeddings, overrides, isolates and marks', [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]],
    ['the zero-width and other format characters', [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad]],
    ['the line and paragraph separators', [0x2028, 0x2029]],
    ['the letters that render as nothing: Hangul fillers, Khmer inherent vowels, blank Braille', [0x115f, 0x1160, 0x3164, 0xffa0, 0x17b4, 0x17b5, 0x2800]],
  ];
  for (const [name, points] of classes) {
    it(name, () => {
      const shown = reviewText(`a${c(...points)}b`);
      expect(shown).toBe(`a${points.map((p) => `<U+${p.toString(16).toUpperCase().padStart(4, '0')}>`).join('')}b`);
    });
  }

  it('keeps newlines, tabs and every printing character verbatim', () => {
    const text = `<b>"x"</b>\n\tcol${c(0xe9, 0x1f600)}`;
    expect(reviewText(text)).toBe(text);
  });

  it('turns a terminal command into plain text: nothing that acts is left', () => {
    const shown = reviewText(`ok${c(0x1b)}[2J${c(0x9b)}2J${c(0x07)}`);
    expect(shown).toBe('ok<U+001B>[2J<U+009B>2J<U+0007>');
    expect(shown).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });
});

describe('blankReason (#2322)', () => {
  it('is blank when only whitespace or invisible characters remain', () => {
    expect(blankReason('')).toBe(true);
    expect(blankReason(' \n\t')).toBe(true);
    expect(blankReason(c(0x200b, 0x2060, 0xfeff, 0x202e, 0x00ad, 0x1b, 0x9b, 0x2028))).toBe(true);
  });
  it('is not blank once a reviewer can read anything', () => {
    expect(blankReason(`${c(0x200b)}why`)).toBe(false);
    expect(blankReason('.')).toBe(false);
  });
});

describe('clipReviewText (#2322)', () => {
  it('shows a short reason whole, and cuts a long one at the character bound without splitting a character', () => {
    expect(clipReviewText('why')).toEqual({ full: 'why', shown: 'why', clipped: false });
    expect(clipReviewText('a'.repeat(REVIEW_TEXT_SHOWN_MAX)).clipped).toBe(false);
    const long = c(0x1f600).repeat(REVIEW_TEXT_SHOWN_MAX + 1);
    const r = clipReviewText(long);
    expect(r.clipped).toBe(true);
    expect(Array.from(r.shown)).toHaveLength(REVIEW_TEXT_SHOWN_MAX);
    expect(r.full).toBe(long);
  });

  it('cuts at the line bound first, so many short lines are bounded in height too', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n');
    expect(clipReviewText(lines(REVIEW_TEXT_SHOWN_LINES)).clipped).toBe(false);
    const r = clipReviewText(lines(REVIEW_TEXT_SHOWN_LINES + 1));
    expect(r).toMatchObject({ clipped: true, shown: lines(REVIEW_TEXT_SHOWN_LINES) });
    // 279 newlines and a character: under the character bound, still cut at six lines.
    expect(clipReviewText(`${'\n'.repeat(REVIEW_TEXT_SHOWN_MAX - 1)}x`).shown).toBe('\n'.repeat(REVIEW_TEXT_SHOWN_LINES - 1));
  });

  it('clips the visible form', () => {
    expect(clipReviewText(`a${c(0x202e)}b`).full).toBe('a<U+202E>b');
  });
});

describe('reviewLine and reviewSql (#2322 r2)', () => {
  it('reviewLine makes a newline and a tab visible too, so a one-line position cannot forge a line', () => {
    expect(reviewLine(`0007\n+ helpdesk 0008-harmless\tx${c(0x202e)}`)).toBe('0007<U+000A>+ helpdesk 0008-harmless<U+0009>x<U+202E>');
    expect(reviewLine('plain-id_0001')).toBe('plain-id_0001');
  });
  it('reviewSql reads CRLF as a line break, and still shows a lone CR', () => {
    expect(reviewSql('SELECT 1;\r\nSELECT 2;\r\n')).toBe('SELECT 1;\nSELECT 2;\n');
    expect(reviewSql('SELECT 1;\rDROP')).toBe('SELECT 1;<U+000D>DROP');
    expect(reviewSql(`a${c(0x1b)}\r\n`)).toBe('a<U+001B>\n');
  });

  it('blankReason counts the blank-rendering letters as nothing', () => {
    expect(blankReason(c(0x115f, 0x1160, 0x3164, 0xffa0, 0x17b4, 0x17b5, 0x2800))).toBe(true);
  });
});
