/**
 * Reading a file through a download link (#3139) — the read-side counterpart of
 * `mountUploadLinkRedeem`.
 *
 * An operation mints the link (`ctx.attachments.mintDownloadUrl`) and hands its URL to a caller with
 * no session: an `<audio>` or `<video>` element, a file an MCP tool hands back, a link in a mail.
 *
 *   GET  /api/attachment-downloads/<attachmentId>/<secret>
 *
 * The file is opened as the principal who minted the link, through the read gate any open takes, so
 * their `readPermission` on the file's owner is asked again on every request. A read spends nothing:
 * the link is good until it expires or is revoked, which a media element needs, since it reads a file
 * in many ranged requests. The answer is `serveAttachment`'s, streamed and seekable and hardened.
 *
 * **404** for a secret that cannot be ours, names nothing, or names another file; **410** for a link
 * that expired or was revoked, said only to a holder of its secret; **403** when the minter can no
 * longer read the file; **404** for a file removed since the mint. The secret is in the path, and the
 * invocation log redacts it (`redactUploadLinkSecret`).
 */
import type { Context, Env, Hono } from 'hono';
import {
  DOWNLOAD_LINK_PATH_PREFIX,
  PROBLEM_CONTENT_TYPE,
  isDownloadLinkSecretShape,
  problemForStatus,
  substratError,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { DOWNLOAD_LINK_GONE, type ScopeHost } from '@substrat-run/kernel';
import { hardenFileResponse, serveAttachment } from './attachment-serve.js';
import { problemFor, withRequestIdMember } from './errors.js';

type Awaitable<T> = T | Promise<T>;

/** Where `mountDownloadLinkRedeem` listens: the one path `downloadLinkPath` mints. */
export const DOWNLOAD_LINK_REDEEM_PATH = `${DOWNLOAD_LINK_PATH_PREFIX}/:attachmentId/:secret`;

export interface DownloadLinkRedeemOptions<E extends Env = Env> {
  /** The host serving the scope. One without `openDownloadLink` answers 503. */
  host: (c: Context<E>) => Awaitable<Pick<ScopeHost, 'openDownloadLink'>>;
  /** Which scope this request is for — the routed node, as for every other route. */
  node: (c: Context<E>) => Awaitable<{ tenantId: TenantId; scopeId: ScopeId }>;
}

/** The request path with its secret, the last segment, left out: what a problem names as its `instance`. */
const instanceOf = (c: Context): string => c.req.path.replace(/\/[^/]+$/, '/…');

const reasonOf = (err: unknown): unknown => (err as { extensions?: { reason?: unknown } } | null)?.extensions?.reason;

/** Mount the redemption. `workerDoor({ attachments: true })` mounts it for you. */
export function mountDownloadLinkRedeem<E extends Env>(app: Hono<E>, options: DownloadLinkRedeemOptions<E>): void {
  app.get(DOWNLOAD_LINK_REDEEM_PATH, async (c) => {
    hardenFileResponse(c);
    try {
      const attachmentId = c.req.param('attachmentId');
      const secret = c.req.param('secret');
      // A secret that cannot be one the kernel minted costs the scope nothing.
      if (!attachmentId || !isDownloadLinkSecretShape(secret)) throw substratError('not_found', 'This download link is not valid.');
      const [host, node] = await Promise.all([options.host(c), options.node(c)]);
      if (!host.openDownloadLink) throw substratError('unavailable', 'this scope host serves no download links');
      const open = host.openDownloadLink.bind(host);
      return await serveAttachment(
        c,
        { openStream: (id, opts) => open(node.tenantId, node.scopeId, secret, id, opts) },
        attachmentId,
        { instance: instanceOf(c) },
      );
    } catch (err) {
      if (reasonOf(err) === DOWNLOAD_LINK_GONE) {
        const gone = problemForStatus(410, 'This download link has expired or was revoked.', instanceOf(c));
        return c.body(JSON.stringify(withRequestIdMember(gone, c)), 410, { 'content-type': PROBLEM_CONTENT_TYPE });
      }
      // The platform's own vocabulary (403 for a minter who lost the key, 404, 503), naming the path
      // without its secret.
      const { status, body } = problemFor(err, instanceOf(c));
      return c.body(JSON.stringify(withRequestIdMember(body, c)), status, { 'content-type': PROBLEM_CONTENT_TYPE });
    }
  });
}
