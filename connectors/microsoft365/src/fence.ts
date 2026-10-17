/**
 * The channel-folder fence (#2101): what a path relative to the bound folder may be.
 *
 * `Sites.Selected` grants the whole site, so the tenant's grant cannot keep the connector inside
 * one channel's folder. This does, in two layers:
 *
 * 1. **The grammar here.** A path is one or more segments joined by `/`, and a segment that could
 *    mean anything but "a child named this" is refused: empty, `.`, `..`, a backslash, a
 *    character SharePoint refuses in a name, leading or trailing whitespace, a trailing dot, a
 *    percent-encoding, a character that is not NFC, or one whose compatibility form (NFKC) is a
 *    separator or a dot segment (`／`, `∕`, `．．`, `‥`). Refused before Graph is called.
 * 2. **Addressing by id.** A write goes to `drives/{drive}/items/{folder}:/{path}:`, relative to
 *    the folder's item id, so even a path that passed the grammar names something under that
 *    item and nothing else. A read keeps only items whose ancestry, by id, reaches the folder.
 *
 * A refusal never echoes the path back: the vertical knows what it sent, and an error string is
 * the one place a name would otherwise leak into logs.
 */

export class FenceError extends Error {
  constructor(reason: string) {
    super(`refused: the path is outside the channel folder's grammar (${reason})`);
    this.name = 'FenceError';
  }
}

/** SharePoint's longest decoded path, library root included. Kept short of it for the folder. */
export const MAX_RELATIVE_PATH = 380;
const MAX_SEGMENT = 255;

/** What SharePoint and OneDrive refuse in a file or folder name. */
const ILLEGAL = /["*:<>?|\\\u0000-\u001f\u007f]/;
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/** Characters whose compatibility form is a separator or a dot: refused, not normalized. */
const LOOKALIKE = /[․‥…∕⁄⧸．／＼﹒﹨∖]/;

/** Check one name. Returns it unchanged, or throws. */
export function fencedSegment(segment: string): string {
  if (segment.length === 0) throw new FenceError('an empty segment');
  if (segment === '.' || segment === '..') throw new FenceError('a dot segment');
  if (segment.normalize('NFC') !== segment) throw new FenceError('a name that is not NFC');
  const compat = segment.normalize('NFKC');
  if (compat.includes('/') || compat.includes('\\') || compat === '.' || compat === '..' || LOOKALIKE.test(segment)) {
    throw new FenceError('a separator or dot lookalike');
  }
  if (ILLEGAL.test(segment)) throw new FenceError('a character SharePoint refuses in a name');
  if (/%[0-9a-f]{2}/i.test(segment)) throw new FenceError('a percent-encoding');
  if (segment !== segment.trim()) throw new FenceError('leading or trailing whitespace');
  if (segment.endsWith('.')) throw new FenceError('a trailing dot');
  if (DEVICE.test(segment)) throw new FenceError('a reserved device name');
  if (segment.toLowerCase().includes('_vti_')) throw new FenceError('a reserved SharePoint name');
  if (segment.length > MAX_SEGMENT) throw new FenceError('a name longer than 255 characters');
  return segment;
}

/**
 * Check a path relative to the channel folder and return its segments. `allowEmpty` admits `''`,
 * meaning the folder itself (a write's directory); a file path is never empty.
 */
export function fencedPath(path: unknown, opts: { allowEmpty?: boolean } = {}): string[] {
  if (typeof path !== 'string') throw new FenceError('not a string');
  if (path === '') {
    if (opts.allowEmpty) return [];
    throw new FenceError('an empty path');
  }
  if (path.startsWith('/')) throw new FenceError('an absolute path');
  if (path.length > MAX_RELATIVE_PATH) throw new FenceError(`a path longer than ${MAX_RELATIVE_PATH} characters`);
  return path.split('/').map(fencedSegment);
}

/** Segments → the URL form Graph's path addressing takes, each segment encoded on its own. */
export const encodedPath = (segments: readonly string[]): string => segments.map(encodeURIComponent).join('/');
