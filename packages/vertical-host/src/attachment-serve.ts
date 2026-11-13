/**
 * One answer to a request for a stored file (#3139), for every route that serves one: the link-share
 * download, the door's own file route, and a vertical's route over `door.attachments(c)`.
 *
 * It streams. The file is read from the blob store as the response is written, never held whole, so
 * the largest file a route can serve is not whatever the worker has memory for.
 *
 * It answers a byte range. A media element asks for `bytes=0-` and then for wherever the listener
 * seeks, and Safari will not play a file whose server ignores the question. One range is answered
 * with a 206 and only those bytes are read from the store; several are answered with the whole file,
 * which RFC 9110 allows. The ETag is the file's SHA-256, which never changes under an id, so an
 * `If-Range` carrying it always holds and anything else is answered with the whole file.
 *
 * The file is always `Content-Disposition: attachment`, and the response is hardened before
 * anything can fail ({@link hardenFileResponse}). A media or image element ignores the disposition,
 * so `<audio src>` and `<img src>` play and show the file; a navigation saves it instead of
 * rendering it as this origin.
 */
import type { Context } from 'hono';
import { PROBLEM_CONTENT_TYPE, problemForStatus, substratError } from '@substrat-run/contracts';
import { knownLengthStream, type ByteRangeSpec, type ScopeAttachments } from '@substrat-run/kernel';
import { withRequestIdMember } from './errors.js';

/**
 * `Content-Disposition` for a stored filename: always `attachment`, so the browser saves
 * the file rather than rendering it on this origin, with an ASCII fallback (quotes,
 * backslashes, control and non-ASCII characters replaced) and the exact name as RFC 5987
 * `filename*`. The filename is the uploader's text, so nothing of it reaches the header raw.
 */
export function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download';
  const exact = encodeURIComponent(filename).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${exact}`;
}

/**
 * The headers every file response carries, set first so a refusal carries them too.
 * `Cache-Control: private, no-store`, since a shared cache must never hold a private file and
 * neither should the browser once access is gone; `Referrer-Policy: no-referrer`;
 * `X-Content-Type-Options: nosniff`; and a `sandbox` CSP, so a file that is secretly HTML cannot
 * run as this origin even if opened directly. The disposition is generic until there is a file to
 * name.
 */
export function hardenFileResponse(c: Context): void {
  c.header('Cache-Control', 'private, no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Security-Policy', "default-src 'none'; sandbox");
  c.header('Content-Disposition', 'attachment');
}

const BYTE_RANGE = /^bytes=[ \t]*(\d*)[ \t]*-[ \t]*(\d*)[ \t]*$/i;

/**
 * A `Range` header as the one byte range it names, or `undefined` for a header to ignore: absent,
 * several ranges, another unit, a malformed or backwards range, or offsets past what a number holds.
 * Ignoring is what RFC 9110 §14.2 asks of a server that will not answer the header, and the whole
 * file is then served.
 */
export function parseByteRange(header: string | undefined): ByteRangeSpec | undefined {
  const match = header === undefined ? null : BYTE_RANGE.exec(header.trim());
  if (!match) return undefined;
  const [, first = '', last = ''] = match;
  const n = (digits: string) => {
    const value = Number(digits);
    return Number.isSafeInteger(value) ? value : undefined;
  };
  if (first === '') {
    const suffix = last === '' ? undefined : n(last);
    return suffix === undefined ? undefined : { suffix };
  }
  const start = n(first);
  if (start === undefined) return undefined;
  if (last === '') return { start };
  const end = n(last);
  return end === undefined || end < start ? undefined : { start, end };
}

const STRONG_SHA256_TAG = /^"[0-9a-f]{64}"$/;

/**
 * Answer the request with attachment `attachmentId`, read through `files`: 200 with the file, 206
 * with the range asked for, 416 for a range with no byte in the file, and `not_found` (thrown) for
 * an id `files` does not open, whether unknown or not the caller's to read. A HEAD gets the headers
 * and no body. Call {@link hardenFileResponse} first, and render a throw with `problemResponse`.
 *
 * `options.instance` is what the 416 names as its `instance`, the request path by default: a route
 * whose path carries a secret passes it without one.
 */
export async function serveAttachment(
  c: Context,
  files: Pick<ScopeAttachments, 'openStream'>,
  attachmentId: string,
  options?: { instance?: string },
): Promise<Response> {
  const head = c.req.method === 'HEAD';
  const ifRange = c.req.header('If-Range')?.trim();
  // Only a GET is answered in part. An `If-Range` that is not one of our tags (a date, a weak tag)
  // cannot match one, so the whole file is what it asks for.
  let range = head ? undefined : parseByteRange(c.req.header('Range'));
  if (range && ifRange !== undefined && !STRONG_SHA256_TAG.test(ifRange)) range = undefined;
  let opened = await files.openStream(attachmentId, range ? { range } : undefined);
  if (opened && range && ifRange !== undefined && ifRange !== `"${opened.record.sha256}"`) {
    await opened.body.stream.getReader().cancel().catch(() => {});
    opened = await files.openStream(attachmentId);
  }
  if (!opened) throw substratError('not_found', 'no such file');
  const { record, body } = opened;
  const headers: Record<string, string> = {
    'Content-Type': opened.contentType,
    'Content-Disposition': attachmentDisposition(record.filename),
    ETag: `"${record.sha256}"`,
    'Accept-Ranges': 'bytes',
  };
  if (opened.range === 'unsatisfiable') {
    const refusal = problemForStatus(
      416,
      `This file is ${record.size} bytes; the range asked for has none of them.`,
      options?.instance ?? c.req.path,
    );
    return c.body(JSON.stringify(withRequestIdMember(refusal, c)), 416, {
      'content-type': PROBLEM_CONTENT_TYPE,
      'Content-Range': `bytes */${record.size}`,
    });
  }
  if (opened.range) headers['Content-Range'] = `bytes ${opened.range.start}-${opened.range.end}/${record.size}`;
  headers['Content-Length'] = String(body.length);
  const status = opened.range ? 206 : 200;
  if (head) {
    // The store's object is let go now rather than when the stream is collected.
    await body.stream.getReader().cancel().catch(() => {});
    return c.body(null, status, headers);
  }
  return c.body(knownLengthStream(body) as unknown as ReadableStream<Uint8Array>, status, headers);
}
