/**
 * A fixture's `version` label written from part of an id (#2402).
 *
 * `vertical_versions` is unique on `(vertical_slug, version)`. The kernel's ulid is monotonic only
 * within a millisecond; in a later one the random half is drawn afresh, so ANY piece of an id
 * (`id.slice(-4)` is 20 bits) is independent between two versions, and a slug that publishes
 * several of them collides now and then, red on a push to `main` with no change to blame
 * (#2402: `UNIQUE constraint failed: vertical_versions.vertical_slug, vertical_versions.version`).
 * The whole id is the only part two ids from one mint never share, so a label is written from all
 * of it: `1.0.${id.toLowerCase()}`.
 *
 * The rule is scoped to VERSION construction, not to cutting an id: a slug, a tag, a ref or a
 * hostname that takes the tail of an id (`slug: \`x-${id.slice(-6)}\``) is judged by its own
 * uniqueness and is not this tool's business. It finds a `version` property (bare, quoted or
 * computed key), takes its VALUE (up to the next top-level `,` or closing bracket, so a later
 * property on the same line is not read, and across a line break when the value starts on the
 * next line) and refuses a value that calls `slice`, `substring` or `substr` on anything: an
 * identifier, a call (`ulid().slice(-4)`, `id.toLowerCase().slice(-4)`), an index. The one cut it
 * allows is a lone `(1)`, which strips a leading character (`v1` -> `1`). A comment or a string
 * that spells such a property is read like code, which fails safe; a quoted key is only a key
 * at the start of a line or after `{` or `,`, so `\`"version": "${v}"\`` inside a template is not. A label reached through a
 * variable (`const tail = id.slice(-4); … version: tail`) is out of its sight.
 */
const KEY = /(?:\bversion|(?<=^[ \t]*|[{,]\s*)(?:(['"])version\1|\[\s*(['"`])version\2\s*\]))\s*:/gm;
const CUT = /\.\s*(?:slice|substring|substr)\s*\(\s*([^)]*?)\s*\)/g;
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);

export const REMEDY =
  'A version label built from a piece of an id collides with another version of the same slug now ' +
  'and then (#2402). Write it from the whole id: `1.0.${id.toLowerCase()}`.';

/**
 * The text of the value that starts at `from`: up to the first `,` or unmatched closing bracket
 * outside every bracket, string and template; or the end of the line once something was read and
 * no bracket is open.
 * @param {string} src
 * @param {number} from
 */
function valueAt(src, from) {
  let i = from;
  let depth = 0;
  let started = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n' && started && depth === 0) break;
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '"' || c === "'") {
      started = true;
      for (i += 1; i < src.length && src[i] !== c && src[i] !== '\n'; i += src[i] === '\\' ? 2 : 1);
      i += 1;
      continue;
    }
    if (c === '`') {
      // One that follows other text is the closing delimiter of a string this "key" sat inside
      // (`"version": "${v}"` in a template), not the start of the value; reading on would run
      // into whatever the next backtick in the file closes.
      if (started && depth === 0) break;
      started = true;
      i = templateEnd(src, i + 1);
      continue;
    }
    if (c === ',' && depth === 0) break;
    if (OPEN.has(c)) depth += 1;
    else if (CLOSE.has(c)) {
      if (depth === 0) break;
      depth -= 1;
    }
    started = true;
    i += 1;
  }
  return src.slice(from, i);
}

/** The index just past the backtick that closes the template whose text starts at `i`. */
function templateEnd(src, i) {
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') i += 2;
    else if (c === '`') return i + 1;
    else if (c === '$' && src[i + 1] === '{') {
      let depth = 1;
      for (i += 2; i < src.length && depth > 0; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') depth -= 1;
        else if (src[i] === '`') i = templateEnd(src, i + 1) - 1;
      }
    } else i += 1;
  }
  return i;
}

/** Whether `value` cuts a piece out of something — anything but a lone `(1)`. */
const cuts = (value) => [...value.matchAll(CUT)].some((m) => m[1] !== '1');

/**
 * @param {string} src
 * @returns {{ line: number, text: string }[]}
 */
export function findTruncatedVersions(src) {
  const lines = src.split('\n');
  const found = [];
  for (const m of src.matchAll(KEY)) {
    const value = valueAt(src, m.index + m[0].length);
    if (!cuts(value)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    found.push({ line, text: lines[line - 1].trim() });
  }
  return found;
}
