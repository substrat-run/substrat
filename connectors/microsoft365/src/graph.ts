import { z } from 'zod';
import type { MailSendResult, OutboundMail } from '@substrat-run/kernel';
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
 * The most attachment bytes one message may carry. Graph's `sendMail` takes a request of at
 * most 4 MB, attachments base64-encoded inside it, so this leaves room for the encoding and the
 * body. A larger file needs a draft and an upload session, and creating a draft needs
 * `Mail.ReadWrite` on the mailbox — which the least-privilege setup deliberately does not grant.
 */
export const MAX_ATTACHMENT_BYTES = Math.floor(2.5 * 1024 * 1024);

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

export async function readSite(client: GraphClient, siteUrl: string): Promise<SiteInfo> {
  const res = await call(client, 'GET', sitePath(siteUrl));
  const body = (await res.json()) as Partial<SiteInfo>;
  return { id: String(body.id ?? ''), displayName: String(body.displayName ?? ''), webUrl: String(body.webUrl ?? siteUrl) };
}

/**
 * Send one message as `mail.from` with `POST /users/{from}/sendMail`.
 *
 * Graph's message has one body, so the HTML part is sent and the text part is not. Only
 * `X-` headers may be set on a message through Graph; any other header is left out rather
 * than failing the send. Accepted (202) means queued, never delivered — Graph does not say more.
 */
export async function sendMail(client: GraphClient, mail: OutboundMail): Promise<MailSendResult> {
  const total = mail.attachments.reduce((n, a) => n + a.content.byteLength, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new GraphError(
      413,
      undefined,
      `the attachments come to ${total} bytes; a message sent through Microsoft 365 carries at most ` +
        `${MAX_ATTACHMENT_BYTES} (larger files need Mail.ReadWrite on the mailbox, which this setup does not grant)`,
    );
  }
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
    ...(mail.attachments.length
      ? {
          attachments: mail.attachments.map((a) => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: a.filename,
            contentType: a.contentType,
            contentBytes: toBase64(a.content),
          })),
        }
      : {}),
  };
  await call(client, 'POST', `users/${encodeURIComponent(mail.from.email)}/sendMail`, {
    message,
    saveToSentItems: true,
  });
  return { delivered: [], queued: mail.to.map((t) => t.email), bounced: [] };
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
  const res = await call(client, 'GET', `${sitePath(siteUrl)}/drive/root:/${encodedPath(segments)}?$select=${SELECT}`);
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

/** Every child of a folder, paged. */
export async function childrenOf(client: GraphClient, driveId: string, itemId: string): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  let url: string | null = `${graphRoot(client)}/drives/${enc(driveId)}/items/${enc(itemId)}/children?$select=${SELECT}`;
  while (url) {
    const body = page.parse(await (await send(client, 'GET', url)).json());
    out.push(...body.value);
    url = body['@odata.nextLink'] ?? null;
  }
  return out;
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
 */
export async function writeUnder(
  client: GraphClient,
  input: {
    driveId: string;
    parentId: string;
    segments: readonly string[];
    body: Uint8Array;
    contentType: string;
    conflict: ConflictBehavior;
  },
): Promise<DriveItem> {
  const target = `drives/${enc(input.driveId)}/items/${enc(input.parentId)}:/${encodedPath(input.segments)}:`;
  if (input.body.byteLength <= SIMPLE_UPLOAD_MAX_BYTES) {
    const res = await send(
      client,
      'PUT',
      `${graphRoot(client)}/${target}/content?@microsoft.graph.conflictBehavior=${input.conflict}`,
      { body: input.body, contentType: input.contentType },
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
  const total = input.body.byteLength;
  try {
    for (let start = 0; start < total; start += UPLOAD_CHUNK_BYTES) {
      const end = Math.min(start + UPLOAD_CHUNK_BYTES, total);
      // The upload URL is pre-authorized; Graph refuses a request to it that carries the token.
      const res = await send(client, 'PUT', session.uploadUrl, {
        auth: false,
        body: input.body.subarray(start, end),
        headers: { 'content-range': `bytes ${start}-${end - 1}/${total}` },
      });
      if (end === total) return driveItem.parse(await res.json());
    }
    throw new GraphError(500, undefined, 'the upload session ended without an item');
  } catch (e) {
    await send(client, 'DELETE', session.uploadUrl, { auth: false }).catch(() => undefined);
    throw e;
  }
}

const enc = encodeURIComponent;
