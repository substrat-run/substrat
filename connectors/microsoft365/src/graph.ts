import { z } from 'zod';
import { isSizedByteStream, type MailSendResult, type OutboundMail, type SizedByteStream } from '@substrat-run/kernel';
import { GRAPH_BASE } from './credential.js';
import { encodedPath } from './fence.js';
import { toBase64 } from './x509.js';

/** What a Graph call needs: an egress that records health, a token, and where Graph is. */
export interface GraphClient {
  fetch(
    input: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array },
  ): Promise<{
    ok: boolean;
    status: number;
    /** Read for `Retry-After` on a throttle (#2102). Optional: a test fetch may omit it. */
    headers?: { get(name: string): string | null };
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
  accessToken: string;
  graphBase?: string;
}

/**
 * A Graph refusal, with the HTTP status and Graph's own error code — and, on a throttle, the
 * seconds Graph asked us to wait (`Retry-After`), which the platform's retry honours (#2102).
 */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

/** `Retry-After` as seconds: Graph sends a delay, but an HTTP date is legal too. */
export function retryAfterSeconds(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : undefined;
}

/**
 * The most attachment bytes one message carries inline, in a single `sendMail`. Graph takes a
 * request of at most 4 MB, attachments base64-encoded inside it, so this leaves room for the
 * encoding and the body. A message with more goes as a draft (`sendMail` below), and creating a
 * draft needs `Mail.ReadWrite` on the mailbox, which the least-privilege setup does not grant
 * unless the tenant adds it for large attachments.
 */
export const MAX_ATTACHMENT_BYTES = Math.floor(2.5 * 1024 * 1024);

/** Graph's smallest attachment upload session; a smaller attachment is posted to the draft whole. */
export const SESSION_ATTACHMENT_MIN_BYTES = 3 * 1024 * 1024;

export interface SiteInfo {
  id: string;
  displayName: string;
  webUrl: string;
}

/** `https://acme.sharepoint.com/sites/Team` → Graph's `sites/{host}:/sites/Team`. */
export function sitePath(siteUrl: string): string {
  const url = new URL(siteUrl);
  const path = url.pathname.replace(/\/+$/, '');
  return path ? `sites/${url.hostname}:${path}` : `sites/${url.hostname}`;
}

/**
 * The site as the start of a longer Graph path. A site addressed by its server-relative path is
 * closed with a colon before anything follows it (`sites/{host}:/sites/Team:/drive/…`); the root
 * site needs none (`sites/{host}/drive/…`).
 */
export function siteSegment(siteUrl: string): string {
  const path = sitePath(siteUrl);
  return path.includes(':') ? `${path}:` : path;
}

export async function readSite(client: GraphClient, siteUrl: string): Promise<SiteInfo> {
  const res = await call(client, 'GET', sitePath(siteUrl));
  const body = (await res.json()) as Partial<SiteInfo>;
  return { id: String(body.id ?? ''), displayName: String(body.displayName ?? ''), webUrl: String(body.webUrl ?? siteUrl) };
}

/**
 * Send one message as `mail.from`.
 *
 * Up to {@link MAX_ATTACHMENT_BYTES} of attachments it is one `POST /users/{from}/sendMail`, which
 * needs only `Mail.Send`. Above that it goes as a draft: `POST /users/{from}/messages`, each
 * attachment added to it (posted whole under {@link SESSION_ATTACHMENT_MIN_BYTES}, through an
 * upload session above), then `POST …/messages/{id}/send`. Creating the draft needs
 * `Mail.ReadWrite`, so a tenant that did not grant it gets a refusal saying so. A draft that fails
 * part-way is deleted (and its open upload session cancelled), best-effort; the original error is
 * thrown either way, and `onDraftLeft` hears about a draft that could not be deleted. Nothing is
 * resumed across deliveries: a retry starts a new draft.
 *
 * Graph's message has one body, so the HTML part is sent and the text part is not. Only
 * `X-` headers may be set on a message through Graph; any other header is left out rather
 * than failing the send. Accepted (202) means queued, never delivered — Graph does not say more.
 */
export async function sendMail(
  client: GraphClient,
  mail: OutboundMail,
  opts: { onDraftLeft?: (error: unknown) => void } = {},
): Promise<MailSendResult> {
  const recipient = (a: { email: string; name?: string }) => ({
    emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) },
  });
  const headers = Object.entries(mail.headers ?? {})
    .filter(([name]) => /^x-/i.test(name))
    .map(([name, value]) => ({ name, value }));
  const message = {
    subject: mail.subject,
    body: { contentType: 'HTML', content: mail.html },
    toRecipients: mail.to.map(recipient),
    ...(mail.replyTo ? { replyTo: [recipient(mail.replyTo)] } : {}),
    ...(headers.length ? { internetMessageHeaders: headers } : {}),
  };
  const user = `users/${encodeURIComponent(mail.from.email)}`;
  const total = mail.attachments.reduce((n, a) => n + a.content.byteLength, 0);
  let step: MailStep = 'send';
  try {
    if (total <= MAX_ATTACHMENT_BYTES) {
      await call(client, 'POST', `${user}/sendMail`, {
        message: { ...message, ...(mail.attachments.length ? { attachments: mail.attachments.map(fileAttachment) } : {}) },
        saveToSentItems: true,
      });
    } else {
      step = 'draft';
      const draft = z.object({ id: z.string().min(1) }).parse(await (await call(client, 'POST', `${user}/messages`, message)).json());
      const at = `${user}/messages/${enc(draft.id)}`;
      try {
        for (const a of mail.attachments) {
          if (a.content.byteLength < SESSION_ATTACHMENT_MIN_BYTES) {
            await call(client, 'POST', `${at}/attachments`, fileAttachment(a));
            continue;
          }
          const session = z.object({ uploadUrl: z.string().min(1) }).parse(
            await (
              await call(client, 'POST', `${at}/attachments/createUploadSession`, {
                AttachmentItem: { attachmentType: 'file', name: a.filename, size: a.content.byteLength, contentType: a.contentType },
              })
            ).json(),
          );
          await uploadToSession(client, session.uploadUrl, bufferReader(a.content));
        }
        step = 'send';
        await call(client, 'POST', `${at}/send`);
      } catch (e) {
        // A draft that was sent after all has moved to Sent Items under another id, so this
        // deletes only a draft still sitting in Drafts.
        await call(client, 'DELETE', at).catch((left: unknown) => opts.onDraftLeft?.(left));
        throw e;
      }
    }
  } catch (e) {
    throw mailError(e, step, mail.from.email);
  }
  return { delivered: [], queued: mail.to.map((t) => t.email), bounced: [] };
}

type MailStep = 'draft' | 'send';

const fileAttachment = (a: OutboundMail['attachments'][number]) => ({
  '@odata.type': '#microsoft.graph.fileAttachment',
  name: a.filename,
  contentType: a.contentType,
  contentBytes: toBase64(a.content),
});

/**
 * A mail refusal in the connector's words. Reworded, never re-typed: the status and `Retry-After`
 * are what the platform's retry reads (#2102), so the new error keeps both.
 */
function mailError(e: unknown, step: MailStep, from: string): unknown {
  if (!(e instanceof GraphError)) return e;
  if (e.status === 403 && step === 'draft') {
    return new GraphError(
      403,
      e.code,
      `Exchange refused a draft in '${from}' — attachments over ${MAX_ATTACHMENT_BYTES} bytes are sent ` +
        `through a draft, which needs Application Mail.ReadWrite in the same RBAC for Applications scope as ` +
        `Mail.Send, and this app's grant does not include it`,
    );
  }
  if (e.status === 403) {
    // Exchange's RBAC for Applications scope is the tenant's fence; say that, not "403".
    return new GraphError(
      403,
      e.code,
      `Exchange refused to send as '${from}' — the address is outside the scope the tenant ` +
        `granted this app (RBAC for Applications), or the grant has not taken effect yet`,
    );
  }
  if (e.status === 429) {
    return new GraphError(
      429,
      e.code,
      'Exchange is throttling this mailbox (about 30 messages a minute) — try again shortly',
      e.retryAfter,
    );
  }
  if (e.status === 413 || e.code === 'ErrorMessageSizeExceeded') {
    return new GraphError(413, e.code, `the message is larger than the most the mailbox '${from}' may send`);
  }
  return e;
}

async function call(client: GraphClient, method: string, path: string, body?: unknown) {
  return send(client, method, `${graphRoot(client)}/${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body), contentType: 'application/json' }),
  });
}

const graphRoot = (client: GraphClient) => `${client.graphBase ?? GRAPH_BASE}/v1.0`;

/**
 * One request to Graph at an absolute URL, with the token. A URL Graph handed back (`nextLink`,
 * `deltaLink`) is followed only when it is under the same Graph root: the token goes nowhere else.
 */
async function send(
  client: GraphClient,
  method: string,
  url: string,
  opts: { body?: string | Uint8Array; contentType?: string; auth?: boolean; headers?: Record<string, string> } = {},
) {
  const auth = opts.auth ?? true;
  if (auth && !url.startsWith(`${graphRoot(client)}/`)) {
    throw new GraphError(400, 'foreignLink', 'refused to send the Graph token to a URL outside Graph');
  }
  const res = await client.fetch(url, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${client.accessToken}` } : {}),
      ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
      ...opts.headers,
    },
    ...(opts.body === undefined ? {} : { body: opts.body }),
  });
  if (res.ok) return res;
  const err = ((await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }).error;
  throw new GraphError(
    res.status,
    err?.code,
    err?.message ?? `Graph answered ${res.status}`,
    retryAfterSeconds(res.headers?.get('retry-after')),
  );
}

// ── drive items (#2101) ──────────────────────────────────────────────────────

/**
 * The fields of a `driveItem` this connector reads, parsed with its own schema: Graph may add a
 * field tomorrow, and an unknown key is stripped rather than trusted.
 */
export const driveItem = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  parentReference: z.object({ id: z.string().optional(), driveId: z.string().optional(), path: z.string().optional() }).optional(),
  file: z
    .object({ mimeType: z.string().optional(), hashes: z.object({ quickXorHash: z.string().optional() }).optional() })
    .optional(),
  folder: z.object({ childCount: z.number().optional() }).optional(),
  root: z.object({}).passthrough().optional(),
  deleted: z.object({ state: z.string().optional() }).optional(),
  size: z.number().optional(),
  cTag: z.string().optional(),
  eTag: z.string().optional(),
  lastModifiedDateTime: z.string().optional(),
  createdDateTime: z.string().optional(),
  createdBy: z.object({ application: z.object({ id: z.string().optional() }).optional() }).optional(),
  webUrl: z.string().optional(),
});
export type DriveItem = z.infer<typeof driveItem>;

const SELECT =
  'id,name,parentReference,file,folder,root,deleted,size,cTag,eTag,lastModifiedDateTime,createdDateTime,createdBy,webUrl';

const page = z.object({
  value: z.array(driveItem),
  '@odata.nextLink': z.string().optional(),
  '@odata.deltaLink': z.string().optional(),
});

/** The folder at `segments` under the site's default document library. */
export async function folderAtPath(client: GraphClient, siteUrl: string, segments: readonly string[]): Promise<DriveItem> {
  const res = await call(client, 'GET', `${siteSegment(siteUrl)}/drive/root:/${encodedPath(segments)}?$select=${SELECT}`);
  return driveItem.parse(await res.json());
}

export async function itemById(client: GraphClient, driveId: string, itemId: string): Promise<DriveItem> {
  const res = await call(client, 'GET', `drives/${enc(driveId)}/items/${enc(itemId)}?$select=${SELECT}`);
  return driveItem.parse(await res.json());
}

/** The item at `segments` under `parentId` — addressed relative to the parent's id. */
export async function itemUnder(
  client: GraphClient,
  driveId: string,
  parentId: string,
  segments: readonly string[],
): Promise<DriveItem> {
  const res = await call(
    client,
    'GET',
    `drives/${enc(driveId)}/items/${enc(parentId)}:/${encodedPath(segments)}?$select=${SELECT}`,
  );
  return driveItem.parse(await res.json());
}

/**
 * One page of the drive's change feed. Delta runs on the drive ROOT: on SharePoint Graph supports
 * it nowhere else, so what comes back covers the whole library and the caller's fence is what
 * keeps the folder. `link` is the previous page's `nextLink` or the last pass's `deltaLink`;
 * `null` starts a full enumeration.
 */
export async function deltaPage(client: GraphClient, driveId: string, link: string | null) {
  const url = link ?? `${graphRoot(client)}/drives/${enc(driveId)}/root/delta?$select=${SELECT}`;
  const res = await send(client, 'GET', url);
  const body = page.parse(await res.json());
  return { items: body.value, next: body['@odata.nextLink'] ?? null, delta: body['@odata.deltaLink'] ?? null };
}

/** One page of a folder's children; `link` is the previous page's `nextLink`, `null` the first. */
export async function childrenPage(client: GraphClient, driveId: string, itemId: string, link: string | null) {
  const url = link ?? `${graphRoot(client)}/drives/${enc(driveId)}/items/${enc(itemId)}/children?$select=${SELECT}`;
  const body = page.parse(await (await send(client, 'GET', url)).json());
  return { items: body.value, next: body['@odata.nextLink'] ?? null };
}

/**
 * A file's bytes, at most `maxBytes` of them: refused on the declared `content-length` before the
 * body is read when Graph sends one, and on what arrived when it does not.
 */
export async function contentOf(client: GraphClient, driveId: string, itemId: string, maxBytes: number): Promise<Uint8Array> {
  const res = await call(client, 'GET', `drives/${enc(driveId)}/items/${enc(itemId)}/content`);
  const tooLarge = () => new GraphError(413, 'tooLarge', `the file is larger than the ${maxBytes} bytes a sync brings in`);
  if (Number(res.headers?.get('content-length') ?? 0) > maxBytes) throw tooLarge();
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.byteLength > maxBytes) throw tooLarge();
  return body;
}

export type ConflictBehavior = 'replace' | 'rename' | 'fail';

/** Graph's largest simple upload this connector sends; anything bigger goes by upload session. */
export const SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
/** One upload-session chunk: a multiple of 320 KiB, as Graph requires. */
export const UPLOAD_CHUNK_BYTES = 320 * 1024 * 10;

/**
 * Write `body` at `segments` under the folder `parentId` — simple PUT up to 4 MB, an upload session
 * above. A session that fails part-way is cancelled, so no half-written upload is left behind; it is
 * never resumed across deliveries (its URL is a capability, and is not stored).
 *
 * `body` may be a stream at its declared length (#2514), read once and never held whole: up to 4 MB
 * it is read to its end into one buffer before the PUT, and above that it is cut into session
 * chunks, one held at a time. The last range, which is what makes Graph commit the item, is sent only
 * once the stream has ended at exactly its length. So a stream that errors (an attachment stream
 * refusing bytes that do not match their record) or runs short or long never commits a file: the
 * session is cancelled and the error is thrown as it came.
 */
export async function writeUnder(
  client: GraphClient,
  input: {
    driveId: string;
    parentId: string;
    segments: readonly string[];
    body: Uint8Array | SizedByteStream;
    contentType: string;
    conflict: ConflictBehavior;
  },
): Promise<DriveItem> {
  const target = `drives/${enc(input.driveId)}/items/${enc(input.parentId)}:/${encodedPath(input.segments)}:`;
  const source = isSizedByteStream(input.body) ? exactReader(input.body) : bufferReader(input.body);
  const total = source.length;
  try {
    if (total <= SIMPLE_UPLOAD_MAX_BYTES) {
      const whole = new Uint8Array(total);
      await source.fill(whole);
      await source.end();
      const res = await send(
        client,
        'PUT',
        `${graphRoot(client)}/${target}/content?@microsoft.graph.conflictBehavior=${input.conflict}`,
        { body: whole, contentType: input.contentType },
      );
      return driveItem.parse(await res.json());
    }
    const session = z
      .object({ uploadUrl: z.string().min(1) })
      .parse(
        await (
          await call(client, 'POST', `${target}/createUploadSession`, {
            item: { '@microsoft.graph.conflictBehavior': input.conflict },
          })
        ).json(),
      );
    return driveItem.parse(await (await uploadToSession(client, session.uploadUrl, source)).json());
  } catch (e) {
    await source.release(e);
    throw e;
  }
}

/**
 * `source` PUT to an upload session a chunk at a time, answered with the committing range's
 * response. A chunk that fails cancels the session, best-effort, and its error is thrown as it came.
 */
async function uploadToSession(client: GraphClient, uploadUrl: string, source: BodyReader) {
  const total = source.length;
  // One chunk's buffer, reused: each PUT is answered before the next fill writes into it.
  const chunk = new Uint8Array(Math.min(UPLOAD_CHUNK_BYTES, total));
  try {
    for (let start = 0; start < total; start += UPLOAD_CHUNK_BYTES) {
      const end = Math.min(start + UPLOAD_CHUNK_BYTES, total);
      const piece = chunk.subarray(0, end - start);
      await source.fill(piece);
      // The committing range waits for the stream's own end, so an error at the end lands first.
      if (end === total) await source.end();
      // The upload URL is pre-authorized; Graph refuses a request to it that carries the token.
      const res = await send(client, 'PUT', uploadUrl, {
        auth: false,
        body: piece,
        headers: { 'content-range': `bytes ${start}-${end - 1}/${total}` },
      });
      if (end === total) return res;
    }
    throw new GraphError(500, undefined, 'the upload session ended without an item');
  } catch (e) {
    await send(client, 'DELETE', uploadUrl, { auth: false }).catch(() => undefined);
    throw e;
  }
}

/** What `writeUnder` reads a body through: `fill` takes exactly the bytes asked for, `end` that none follow. */
interface BodyReader {
  length: number;
  fill(into: Uint8Array): Promise<void>;
  end(): Promise<void>;
  /** Let go of a stream not read to its end. */
  release(reason: unknown): Promise<void>;
}

function bufferReader(body: Uint8Array): BodyReader {
  let at = 0;
  return {
    length: body.byteLength,
    fill: async (into) => {
      into.set(body.subarray(at, at + into.byteLength));
      at += into.byteLength;
    },
    end: async () => {},
    release: async () => {},
  };
}

/**
 * A sized stream read to exactly its declared length. A piece larger than the space left is split,
 * and the rest kept for the next `fill`. Short or long is an error, never a shorter or longer file.
 */
function exactReader(body: SizedByteStream): BodyReader {
  const reader = body.stream.getReader();
  let rest: Uint8Array | undefined;
  let read = 0;
  let ended = false;
  const wrongLength = (got: string) => new Error(`the body is not the ${body.length} bytes it declared (${got})`);
  return {
    length: body.length,
    fill: async (into) => {
      let at = 0;
      while (at < into.byteLength) {
        if (!rest?.byteLength) {
          const next = await reader.read();
          if (next.done) {
            ended = true;
            throw wrongLength(`it ended after ${read} bytes`);
          }
          rest = next.value;
          continue;
        }
        const n = Math.min(rest.byteLength, into.byteLength - at);
        into.set(rest.subarray(0, n), at);
        rest = rest.subarray(n);
        at += n;
        read += n;
      }
    },
    end: async () => {
      if (rest?.byteLength) throw wrongLength('more followed');
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value?.byteLength) throw wrongLength('more followed');
      }
      ended = true;
    },
    release: async (reason) => {
      if (!ended) await reader.cancel(reason).catch(() => {});
    },
  };
}

const enc = encodeURIComponent;
