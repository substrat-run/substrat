/**
 * Text a vertical's author wrote, as a person reviewing it is shown it (#2322): a discard's
 * reason, a declared table or column, a migration's id and its SQL. The promote review shows it
 * in a terminal (`substrat promote`), the dashboard and the console, and in each the author's
 * text must read as what is stored, no more and no less.
 *
 * Shared by every surface, so one rule decides what a reviewer sees, and by the push boundary
 * and the kernel's data-loss fence, so a reason they accept is one a review can show.
 */

/**
 * Every character a reviewer cannot see, or that acts instead of printing:
 * - `\p{Cc}`: the C0 controls (ESC, CR, BEL, backspace…), DEL and the C1 controls (U+0080–U+009F,
 *   CSI U+009B among them), which a terminal may act on;
 * - `\p{Cf}`: the format characters — the bidirectional embeddings, overrides, isolates and marks
 *   (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F, U+061C), which reorder what is read, and the
 *   zero-width ones (U+200B–U+200D, U+2060, U+FEFF, the soft hyphen…), which hide;
 * - U+2028 and U+2029, the line and paragraph separators, which break a line without being one;
 * - the letters that render as nothing: the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the
 *   Khmer inherent vowels (U+17B4, U+17B5) and the blank Braille pattern (U+2800), which are not
 *   format characters but read exactly like one.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029\u115F\u1160\u17B4\u17B5\u2800\u3164\uFFA0]/gu;
const ANY_INVISIBLE = new RegExp(INVISIBLE.source, 'u');

/**
 * The two layout characters kept as they are: a newline (the CLI prints SQL line by line and a
 * quoted reason escapes it; the web shows it as a line break, bounded by {@link clipReviewText})
 * and a tab, which only moves to the next column.
 */
const LAYOUT = new Set(['\n', '\t']);

const codePoint = (c: string): string => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`;

/**
 * Author-written text with every invisible or acting character replaced by a visible
 * `<U+XXXX>`, so it cannot reorder, hide or forge what a reviewer reads, nor drive a terminal.
 * Newlines and tabs are kept. Everything else is verbatim; each surface still escapes for its
 * own medium (React's text node, the CLI's quoting).
 */
export function reviewText(text: string): string {
  return text.replace(INVISIBLE, (c) => (LAYOUT.has(c) ? c : codePoint(c)));
}

/**
 * Author-written text for a position that is ONE line — an id, a table or column name — where a
 * kept newline or tab would forge another line: {@link reviewText}, with those made visible too.
 */
export function reviewLine(text: string): string {
  return text.replace(INVISIBLE, codePoint);
}

/**
 * A migration's SQL as a review shows it: {@link reviewText} after a CRLF line ending is read as
 * the line break it is, so SQL saved with Windows line endings does not end every line with a
 * mark. A lone CR still shows, since it returns to the line's start without breaking it.
 */
export function reviewSql(sql: string): string {
  return reviewText(sql.replace(/\r\n/g, '\n'));
}

/**
 * Whether text holds any character {@link reviewText} would have to make visible, newline and tab
 * included: what the push boundary refuses where a value must be plain (a migration's version).
 */
export function hasInvisible(text: string): boolean {
  return ANY_INVISIBLE.test(text);
}

/**
 * Whether a reason says nothing a reviewer could read: empty once whitespace and every
 * invisible character are removed. The push boundary (`declaredMigration`) and the kernel's
 * data-loss fence both refuse a discard whose reason is blank by this one rule.
 */
export function blankReason(text: string): boolean {
  return text.replace(INVISIBLE, '').replace(/\s/gu, '') === '';
}

/** How much of a discard's reason a review shows before it asks to be expanded: characters… */
export const REVIEW_TEXT_SHOWN_MAX = 280;
/** …and lines, whichever comes first, so a reason of many short lines is bounded in height too. */
export const REVIEW_TEXT_SHOWN_LINES = 6;

/**
 * A reason as a review first shows it: {@link reviewText}, cut at
 * {@link REVIEW_TEXT_SHOWN_MAX} characters (never inside a surrogate pair) or
 * {@link REVIEW_TEXT_SHOWN_LINES} lines, whichever comes first, with `clipped` set, so a long
 * reason cannot push the rest of the review out of sight. The full text is shown on request.
 */
export function clipReviewText(text: string): { full: string; shown: string; clipped: boolean } {
  const full = reviewText(text);
  const chars = Array.from(full);
  let end = Math.min(chars.length, REVIEW_TEXT_SHOWN_MAX);
  let lines = 1;
  for (let i = 0; i < end; i++) {
    if (chars[i] === '\n' && ++lines > REVIEW_TEXT_SHOWN_LINES) {
      end = i;
      break;
    }
  }
  if (end === chars.length) return { full, shown: full, clipped: false };
  return { full, shown: chars.slice(0, end).join(''), clipped: true };
}
