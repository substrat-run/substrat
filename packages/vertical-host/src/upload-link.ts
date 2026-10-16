/**
 * Redeeming an upload link — the HTTP half of `ctx.attachments.mintUploadUrl`.
 *
 * An operation mints a link and returns its path; a caller with no cookie and no bearer — an MCP
 * client's shell, a `curl` — sends the bytes here:
 *
 * ```sh
 * curl --upload-file contract.pdf \
 *   "https://crm.example/api/attachment-uploads/contract/01J…/sbup_…?filename=contract.pdf"
 * ```
 *
 * **The secret is the whole authority, and it is in the path.** There is no session, no
 * cookie and no `Authorization` header to carry it, and a header-only secret could not be
 * used with `curl --upload-file URL` alone. The price is that the path reaches whatever logs
 * paths. What contains that: the secret is single-use and dead within the hour, the platform
 * stores only its hash, and `invocationLog` writes the secret segment as `[redacted]`. What it
 * cannot reach is a log the runtime keeps of full request URLs (Workers Logs, a proxy in front
 * of the vertical): a link there is dead once used, and unused for an hour at most.
 *
 * **It is the platform's upload, not a second one.** The route reads the body under the link's
 * size ceiling, resolves a media type, refuses what the link's policy refuses, and hands the
 * bytes to `ScopeHost.redeemUploadLink`, which writes them through the same attachment write
 * any upload takes: bytes to the blob store first, then the row and `attachment.added` in one
 * scope transaction, authored by the principal who minted the link and checked against the
 * target's `writePermission` as them, now. The link is spent in that transaction, so every
 * failure leaves it unspent.
 *
 * Answers: **201** `{ id, filename, contentType, size, sha256 }`; **404** for a secret that
 * names nothing — a malformed one answered here, without asking the scope — and for a path
 * naming another target than the link's, whatever the link's state (nothing is spent);
 * **410** for a link already used, expired or revoked at its own path; **413** over the link's size;
 * **415** for a type the link refuses; **403** when the minter no longer holds the key.
 *
 * **Response hygiene, set before anything can fail.** `Cache-Control: no-store`,
 * `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. There is no `ETag`,
 * `Last-Modified` or `Location` — nothing in the answer is a handle on the bytes beyond the
 * `sha256` the uploader already knows — and the secret is never echoed.
 *
 * **CORS: this route sends none, and removes what an outer layer set.** A blanket
 * `app.use('*', cors())` would otherwise let any page that learns a link read its answer.
 * A browser page on another origin that really must upload must have CORS added for THIS
 * path on purpose; a script, an MCP client and `curl` need none.
 */
import type { Context, Env, Hono } from 'hono';
import {
  PROBLEM_CONTENT_TYPE,
  UPLOAD_LINK_PATH_PREFIX,
  isUploadLinkSecretShape,
  substratError,
  uploadLinkFilename,
  type ErrorCode,
  type UploadLinkView,
} from '@substrat-run/contracts';
import {
  UPLOAD_LINK_GONE,
  UPLOAD_LINK_TOO_LARGE,
  UPLOAD_LINK_TYPE_REFUSED,
  UPLOAD_LINK_WRONG_TARGET,
  uploadContentTypeAllowed,
  type ScopeHost,
} from '@substrat-run/kernel';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { problemOf, messageOf } from './errors.js';
import type { CapabilityNode } from './capability-exchange.js';

type Awaitable<T> = T | Promise<T>;

/**
 * Where `mountUploadLinkRedeem` listens — the one path, not an option: `uploadLinkPath` mints
 * URLs under it, and `invocationLog` redacts the secret segment under it.
 */
export const UPLOAD_LINK_REDEEM_PATH = `${UPLOAD_LINK_PATH_PREFIX}/:entityType/:entityId/:secret`;

export interface UploadLinkRedeemOptions<E extends Env = Env> {
  /** The host serving the scope. Taken structurally — any host with the two link verbs. */
  host: (c: Context<E>) => Awaitable<Pick<ScopeHost, 'inspectUploadLink' | 'redeemUploadLink'>>;
  /** Which scope this request is for — the router-asserted (tenant, scope) the vertical already resolves. */
  node: (c: Context<E>) => Awaitable<CapabilityNode>;
}

// ---------------------------------------------------------------------------
// The media type. A client's `Content-Type` is a claim; the bytes get a say where they can.
// ---------------------------------------------------------------------------

const GENERIC_TYPES = new Set(['application/octet-stream', 'application/x-www-form-urlencoded', 'binary/octet-stream']);

const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const startsWith = (bytes: Uint8Array, magic: readonly number[]): boolean =>
  bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);

/** The few types whose first bytes say what they are. Anything else is `null`: not sniffable, not suspect. */
export function sniffMediaType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'; // GIF8
  return null;
}
const SNIFFABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif']);

const normalizeType = (raw: string): string => {
  const t = raw.split(';')[0]!.trim().toLowerCase();
  return t === 'image/jpg' ? 'image/jpeg' : t;
};

/**
 * The type the platform will record. Order: the request's own `Content-Type` unless it is
 * generic (`curl --upload-file` sends none), else the file name's extension, else what the
 * bytes say, else `application/octet-stream`. A claim about a type the bytes can prove — PDF,
 * PNG, JPEG, GIF — that the bytes contradict is refused (`null`), as is a sniffable file under
 * another claim: a `.pdf` that is a PNG is not what the link's allowlist was written for.
 */
export function resolveUploadMediaType(
  header: string | undefined,
  filename: string,
  bytes: Uint8Array,
): string | null {
  const fromHeader = header ? normalizeType(header) : '';
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : '';
  const claimed = fromHeader && !GENERIC_TYPES.has(fromHeader) ? fromHeader : (EXTENSION_TYPES[ext] ?? null);
  const sniffed = sniffMediaType(bytes);
  if (claimed === null) return sniffed ?? 'application/octet-stream';
  if (SNIFFABLE.has(claimed)) return sniffed === claimed ? claimed : null;
  return sniffed !== null ? null : claimed;
}

// ---------------------------------------------------------------------------
// The file name.
// ---------------------------------------------------------------------------

function dispositionFilename(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      return undefined;
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  return (plain?.[1] ?? plain?.[2])?.trim();
}

/** A leaf name, never a path: what the uploader called it, cleaned, or `undefined` if nothing usable. */
function cleanFilename(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const leaf = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  return uploadLinkFilename.safeParse(cleaned).success ? cleaned : undefined;
}

// ---------------------------------------------------------------------------
// The body, read under a ceiling.
// ---------------------------------------------------------------------------

class TooLarge extends Error {}

/** Read the request body, refusing past `max` bytes as they arrive — not after buffering them all. */
async function readBody(request: Request, max: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > max) throw new TooLarge();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The answers.
// ---------------------------------------------------------------------------

const reasonOf = (err: unknown): string | undefined => {
  const ext = (err as { extensions?: { reason?: unknown } } | null)?.extensions;
  return typeof ext?.reason === 'string' ? ext.reason : undefined;
};

const STATUS_BY_REASON: Readonly<Record<string, ContentfulStatusCode>> = {
  [UPLOAD_LINK_GONE]: 410,
  [UPLOAD_LINK_TOO_LARGE]: 413,
  [UPLOAD_LINK_TYPE_REFUSED]: 415,
  [UPLOAD_LINK_WRONG_TARGET]: 404,
};

const CORS_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-expose-headers',
  'vary',
];

function refuse(c: Context, err: unknown): Response {
  const reason = reasonOf(err);
  const status = reason !== undefined ? STATUS_BY_REASON[reason] : undefined;
  if (status === undefined) {
    // Not ours to reclassify: the platform's ordinary vocabulary (403 for a lost key, 404 for an unknown secret).
    const { status: decided, body } = problemOf(
      { status: errorStatus(err), message: messageOf(err) },
      err,
      c.req.path.replace(/\/[^/]+$/, '/…'),
    );
    return c.body(JSON.stringify(body), decided, { 'content-type': PROBLEM_CONTENT_TYPE });
  }
  const body = {
    type: 'about:blank',
    title: reason,
    status,
    detail: messageOf(err),
    reason,
  };
  return c.body(JSON.stringify(body), status, { 'content-type': PROBLEM_CONTENT_TYPE });
}

const STATUS_BY_CODE: Partial<Record<ErrorCode, ContentfulStatusCode>> = {
  unauthenticated: 401,
  permission_denied: 403,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 400,
  unavailable: 503,
};
function errorStatus(err: unknown): ContentfulStatusCode {
  const code = (err as { code?: ErrorCode } | null)?.code;
  return (code && STATUS_BY_CODE[code]) || 500;
}

/** The 404 every secret that names nothing gets — the scope's answer, and this route's for a malformed one. */
const unknownLink = () => substratError('not_found', 'This upload link is not valid.');

/**
 * Mount `PUT` and `POST` on `UPLOAD_LINK_REDEEM_PATH`: redeem one upload link. See the module
 * header for the answers and the hygiene.
 */
export function mountUploadLinkRedeem<E extends Env>(app: Hono<E>, options: UploadLinkRedeemOptions<E>): void {
  const path = UPLOAD_LINK_REDEEM_PATH;
  const handler = async (c: Context<E>): Promise<Response> => {
    // Before anything can fail: nothing here may be cached or handed onwards, and an outer
    // blanket CORS layer must not make the answer readable by a page that learned the link.
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    for (const name of CORS_HEADERS) c.header(name, undefined);
    try {
      const entityType = c.req.param('entityType');
      const entityId = c.req.param('entityId');
      const secret = c.req.param('secret');
      // A secret that cannot be one the kernel minted costs the scope nothing: the same 404 an
      // unknown one gets, before the host, the scope or its Durable Object is touched.
      if (!entityType || !entityId || !isUploadLinkSecretShape(secret)) throw unknownLink();
      const [host, node] = await Promise.all([options.host(c), options.node(c)]);
      if (!host.inspectUploadLink || !host.redeemUploadLink) {
        throw substratError('unavailable', 'this scope host serves no upload links');
      }
      // The link first, so a refusal costs no body: unknown or minted for another target (404,
      // judged before its state), used / expired / revoked (410), and what the body will be
      // judged against.
      const view: UploadLinkView = await host.inspectUploadLink(node.tenantId, node.scopeId, secret, {
        entityType,
        entityId,
      });
      const filename =
        view.filename ??
        cleanFilename(c.req.query('filename')) ??
        cleanFilename(dispositionFilename(c.req.header('content-disposition'))) ??
        'upload';
      let body: Uint8Array;
      try {
        body = await readBody(c.req.raw, view.maxBytes);
      } catch (err) {
        if (err instanceof TooLarge) {
          throw substratError('validation_failed', `The file is larger than the ${view.maxBytes} bytes this link admits.`, {
            reason: UPLOAD_LINK_TOO_LARGE,
          });
        }
        throw err;
      }
      if (body.byteLength === 0) throw substratError('validation_failed', 'An empty file cannot be uploaded.');
      const contentType = resolveUploadMediaType(c.req.header('content-type'), filename, body);
      if (contentType === null || !uploadContentTypeAllowed(view.contentTypes, contentType)) {
        throw substratError('validation_failed', 'A file of that type is not admitted by this link.', {
          reason: UPLOAD_LINK_TYPE_REFUSED,
        });
      }
      const record = await host.redeemUploadLink(node.tenantId, node.scopeId, secret, {
        entity: view.entity,
        filename,
        contentType,
        body,
      });
      return c.body(
        JSON.stringify({
          id: record.id,
          filename: record.filename,
          contentType: record.contentType,
          size: record.size,
          sha256: record.sha256,
        }),
        201,
        { 'content-type': 'application/json' },
      );
    } catch (err) {
      return refuse(c, err);
    }
  };
  app.put(path, handler);
  app.post(path, handler);
}
