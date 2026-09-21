/**
 * The inbox search box's ceiling (#1655).
 *
 * A leaf, for `sla.ts`'s reason: no imports, so the vertical's own suite can reach it
 * without a DOM. A hosted desk's database refuses a `LIKE` pattern over 50 bytes, and the
 * server answers a longer term with a 400 (`searchTerm` in `spec/model.ts`); the box
 * says so before asking, rather than round-tripping to the refusal.
 *
 * Restated rather than imported, because `spec/model.ts` is not browser code.
 * `test/search-term.test.ts` asserts this agrees with the model's own `likeTerm` and
 * `LIKE_PATTERN_MAX_BYTES` on the boundary, so this is a second reader of one bound.
 */

/** The longest `LIKE` pattern a Durable Object's SQLite runs, in UTF-8 bytes. */
export const LIKE_PATTERN_MAX_BYTES = 50;

/** The pattern the server builds for a term: wildcards escaped, wrapped in `%…%`. */
const likePattern = (term: string): string =>
  `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** The bytes of pattern a term costs — what the server judges, not the characters typed. */
export const searchTermBytes = (term: string): number =>
  new TextEncoder().encode(likePattern(term)).length;

/** Whether the server will accept the term. The floor is the caller's; this is the ceiling. */
export const searchTermFits = (term: string): boolean =>
  searchTermBytes(term) <= LIKE_PATTERN_MAX_BYTES;

/**
 * What the box says when a term is over. Bytes, not characters: `å` is two and each
 * `%`, `_` or `\` counts twice, so an honest number is a byte number.
 */
export const SEARCH_TOO_LONG_HINT = `Search is limited to ${LIKE_PATTERN_MAX_BYTES - 2} bytes — about ${LIKE_PATTERN_MAX_BYTES - 2} plain letters, fewer with accents, symbols or % _ \\`;
