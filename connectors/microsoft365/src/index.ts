/**
 * `@substrat-run/connector-microsoft365` — a tenant's own Microsoft 365, over Microsoft Graph
 * with app-only client credentials in the tenant's own Entra directory (#2100).
 *
 * Host code, never module code. It sends mail as the tenant: it implements the kernel's
 * `MailSender`, so the platform's email relay routes a vertical's message to it when the
 * message's `from` is one of the connection's addresses (#2098). And it keeps documents in one
 * Teams channel's SharePoint folder (#2101, `files.ts`): writes requested by an event
 * (`microsoft365.channel-files-requested`, dispatched), reads by a sweep of the library's change
 * feed, landed through the vertical's own operation.
 *
 * **Least privilege is the tenant's, and this connector assumes it.** The app registration
 * holds only `Sites.Selected` in Entra; the right to send is granted in Exchange with RBAC for
 * Applications, scoped to the sender mailboxes, and the right to a site is granted per site.
 * So the app can send as the addresses the tenant chose and no other, cannot read any mailbox,
 * and reaches no site it was not given. A send Exchange refuses is reported as outside the
 * scope the tenant granted.
 *
 * **The keypair is the platform's, one per connection.** With no client secret, the platform
 * generates a keypair and a self-signed certificate when the connection is created
 * (`prepareMicrosoft365Candidate`), seals the private key with the rest of the credential, and
 * serves the certificate for the tenant to upload. The connection is saved before the tenant
 * can upload it, so "the certificate is not on the app registration yet" is an inconclusive
 * probe, never a refusal. A certificate is rotated before it lapses by a second keypair beside
 * the first, promoted once Entra accepts it (`prepareMicrosoft365Candidate`).
 */
import {
  instant,
  type ConnectionCertificate,
  type ConnectionCredential,
  type ConnectionProbe,
} from '@substrat-run/contracts';
import type { FetchLike, MailSender, ScopeHost } from '@substrat-run/kernel';
import {
  graph,
  loginOf,
  nowOf,
  openMicrosoft365Connection,
  openSecret,
  signedInGraph,
  type ConnectionRef,
  type Microsoft365Options,
} from './connection.js';
import {
  acquireToken,
  authMethodOf,
  microsoft365Secret,
  prepareMicrosoft365Candidate,
  requestToken,
  sendersOf,
  signingCredential,
  withNextOnly,
  type Microsoft365Secret,
} from './credential.js';
import { GraphError, readSite, sendMail } from './graph.js';
import { certificatePem, thumbprintSha1Hex } from './x509.js';

export {
  prepareMicrosoft365Candidate,
  microsoft365Secret,
  sendersOf,
  classifyTokenError,
  ROTATE_FIELD,
  ROTATION_WINDOW_DAYS,
  LOGIN_BASE,
  GRAPH_BASE,
} from './credential.js';
export type { Microsoft365Secret, AuthMethod, TokenOutcome } from './credential.js';
export { GraphError, MAX_ATTACHMENT_BYTES, SIMPLE_UPLOAD_MAX_BYTES, UPLOAD_CHUNK_BYTES, sitePath } from './graph.js';
export type { ConflictBehavior, DriveItem } from './graph.js';
export { MICROSOFT365_PROVIDER, type Microsoft365Options } from './connection.js';
export { FenceError, fencedPath, fencedSegment, MAX_RELATIVE_PATH } from './fence.js';
export {
  MICROSOFT365_FILES_EVENT,
  MAX_FILES_PER_EVENT,
  MAX_FILE_BYTES,
  microsoft365FilesRequested,
  microsoft365ChannelChange,
  bindMicrosoft365Scope,
  listMicrosoft365Bindings,
  unbindMicrosoft365Scope,
  microsoft365FilesConnector,
  registerMicrosoft365FilesConnector,
  declareMicrosoft365FilesConnector,
  syncMicrosoft365Scope,
  sweepMicrosoft365Files,
  withSuffix,
} from './files.js';
export type {
  Microsoft365Binding,
  Microsoft365ChannelChange,
  Microsoft365FilesRequested,
  Microsoft365SyncResult,
  Microsoft365SweepResult,
} from './files.js';
export {
  generateCertificate,
  certificatePem,
  thumbprintS256,
  thumbprintSha1Hex,
  CERTIFICATE_VALIDITY_DAYS,
} from './x509.js';

/**
 * No standing grants. Sending mail lands nothing in a scope; an attachment a message carries
 * is read as this connection, so the tenant grants that read on the target it means to send
 * from — per vertical, which is why no fixed key can be named here. The channel-folder sync
 * (#2101) lands through the vertical's own operation, whose permission the binding names and
 * `bindMicrosoft365Scope` checks.
 */
export const MICROSOFT365_CONNECTION_GRANTS: readonly string[] = [];

/** Check a credential that is not stored yet — the connect-time gate. */
export async function probeMicrosoft365Secret(
  raw: Record<string, string>,
  options: Microsoft365Options,
): Promise<ConnectionProbe> {
  const parsed = microsoft365Secret.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    return probeOf({ ok: false, refused: true, error: `incomplete credential: ${fields}` });
  }
  return probeWith(options.fetch, parsed.data, options);
}

/** Check the live connection's credential — **Test connection**. */
export async function probeMicrosoft365Connection(
  host: ScopeHost,
  connection: ConnectionRef,
  options: Microsoft365Options,
): Promise<ConnectionProbe> {
  const conn = await openMicrosoft365Connection(host.admin, options, connection);
  return probeWith(conn.fetch, conn.secret, options);
}

async function probeWith(
  fetchImpl: FetchLike,
  secret: Microsoft365Secret,
  options: Microsoft365Options,
): Promise<ConnectionProbe> {
  // The certificate that signs a send right now, and no fallback: before a lapse that is the current
  // one, and the successor is judged by `successorFacts`, unrecorded, so a rotation's expected "not
  // uploaded yet" never lands in the connection's health. After a lapse the successor IS what
  // signs, so it is the probe's own sign-in and asked about once.
  const now = nowOf(options);
  const signing = signingCredential(secret, now);
  const lapsed = signing !== secret;
  const [token, successor] = await Promise.all([
    requestToken(fetchImpl, signing, { now, ...loginOf(options) }),
    lapsed ? [] : successorFacts(secret, options),
  ]);
  const facts = [
    { label: 'Signs in with', value: authMethodOf(secret) === 'certificate' ? 'certificate' : 'client secret' },
    { label: 'Sends as', value: sendersOf(secret).join(', ').slice(0, 400) },
    ...(secret.certificateNotAfter
      ? [{ label: 'Certificate expires', value: secret.certificateNotAfter.slice(0, 10) }]
      : []),
    ...successor,
    ...(lapsed
      ? [
          { label: 'New certificate expires', value: signing.certificateNotAfter!.slice(0, 10) },
          {
            label: 'Certificate',
            value: 'lapsed — signing with the new certificate; save the connection to switch to it for good',
          },
        ]
      : []),
  ];
  if (!token.ok) return probeOf({ ok: false, refused: token.refused, error: token.error, facts });
  try {
    const site = await readSite(graph(fetchImpl, token.accessToken, options), secret.siteUrl);
    return probeOf({
      ok: true,
      accountRef: site.id || null,
      accountLabel: site.displayName || site.webUrl,
      // Mail cannot be probed without sending: the app deliberately cannot read a mailbox.
      facts: [...facts, { label: 'Mail', value: 'not verified until the first send' }],
    });
  } catch (e) {
    if (e instanceof GraphError && (e.status === 401 || e.status === 403)) {
      // Signed in, but the site is not granted (yet): a SharePoint admin's step, still to do.
      return probeOf({
        ok: false,
        refused: false,
        error: `signed in, but this app has no access to ${secret.siteUrl} yet — grant it Write on the site (Sites.Selected; Read is enough for mail alone)`,
        facts,
      });
    }
    if (e instanceof GraphError && e.status === 404) {
      return probeOf({ ok: false, refused: true, error: `no SharePoint site at ${secret.siteUrl}`, facts });
    }
    return probeOf({ ok: false, refused: false, error: e instanceof Error ? e.message : String(e), facts });
  }
}

/**
 * What the probe says about a successor certificate being rotated in: whether Entra accepts it
 * yet. Asked through the UNRECORDED fetch, because a successor not uploaded yet is the expected
 * state of a rotation, not a failure of the connection, and must not read as one in its health.
 */
async function successorFacts(secret: Microsoft365Secret, options: Microsoft365Options) {
  const next = withNextOnly(secret);
  if (!next) return [];
  const token = await acquireToken(options.fetch, next, { now: nowOf(options), ...loginOf(options) });
  return [
    { label: 'New certificate expires', value: next.certificateNotAfter!.slice(0, 10) },
    {
      label: 'New certificate',
      value: token.ok
        ? 'on the app registration — save the connection to switch to it'
        : `not accepted yet: ${token.error}`.slice(0, 400),
    },
  ];
}

/** The stored credential, reduced: identifiers whole, the client secret masked, no key. */
export async function microsoft365CredentialSummary(
  host: ScopeHost,
  connection: ConnectionRef,
): Promise<ConnectionCredential> {
  const { secret } = await openSecret(host.admin, connection);
  const fields = [
    { key: 'tenantId', label: 'Directory (tenant) ID', value: secret.tenantId, masked: false },
    { key: 'clientId', label: 'Application (client) ID', value: secret.clientId, masked: false },
    { key: 'senders', label: 'Sends as', value: sendersOf(secret).join(', ').slice(0, 200), masked: false },
    { key: 'siteUrl', label: 'SharePoint site', value: secret.siteUrl.slice(0, 200), masked: false },
  ];
  if (authMethodOf(secret) === 'client-secret') {
    fields.push({ key: 'clientSecret', label: 'Client secret', value: mask(secret.clientSecret!), masked: true });
  } else if (secret.certificate) {
    fields.push({
      key: 'certificate',
      label: 'Certificate thumbprint',
      value: await thumbprintSha1Hex(secret.certificate),
      masked: false,
    });
    fields.push({
      key: 'certificateNotAfter',
      label: 'Certificate expires',
      value: secret.certificateNotAfter ?? 'unknown',
      masked: false,
    });
    const next = withNextOnly(secret);
    if (next) {
      fields.push({
        key: 'nextCertificate',
        label: 'New certificate thumbprint',
        value: await thumbprintSha1Hex(next.certificate!),
        masked: false,
      });
      fields.push({
        key: 'nextCertificateNotAfter',
        label: 'New certificate expires',
        value: next.certificateNotAfter!,
        masked: false,
      });
    }
  }
  return { fields };
}

/** The public certificate the tenant uploads to its app registration; `null` with a client secret. */
export async function microsoft365Certificate(
  host: ScopeHost,
  connection: ConnectionRef,
): Promise<ConnectionCertificate | null> {
  const { secret } = await openSecret(host.admin, connection);
  if (authMethodOf(secret) !== 'certificate' || !secret.certificate || !secret.certificateNotAfter) return null;
  const next = withNextOnly(secret);
  const [view, nextView] = await Promise.all([
    certificateView(secret.certificate, secret.certificateNotAfter),
    next ? certificateView(next.certificate!, next.certificateNotAfter!) : undefined,
  ]);
  return { ...view, ...(nextView ? { next: nextView } : {}) };
}

const certificateView = async (certificate: string, notAfter: string) => ({
  pem: certificatePem(certificate),
  thumbprint: await thumbprintSha1Hex(certificate),
  notAfter: instant.parse(notAfter),
});

/**
 * The platform's half of a candidate credential (`ConnectionInspector.prepareCandidate`): the
 * keypair, and its rotation. A pending successor is promoted on a save once Entra accepts it, so
 * the sign-in here goes to Microsoft, unrecorded: it checks a certificate, not the connection.
 */
export function prepareMicrosoft365(options: Microsoft365Options & { commonName: string }) {
  return (candidate: Record<string, string>, previous: Record<string, string> | undefined) => {
    const now = nowOf(options);
    return prepareMicrosoft365Candidate(candidate, previous, {
      now,
      commonName: options.commonName,
      signIn: (secret) => acquireToken(options.fetch, secret, { now, ...loginOf(options) }),
    });
  };
}

/** Mail as the tenant (#2098): the addresses the tenant scoped the app to, sent through Graph. */
export function microsoft365MailSender(options: Microsoft365Options): MailSender {
  return {
    senders: async (host, connection) => sendersOf((await openSecret(host.admin, connection)).secret),
    send: async (host, connection, mail) => {
      const conn = await openMicrosoft365Connection(host.admin, options, connection);
      const client = await signedInGraph(conn, options);
      try {
        return await sendMail(client, mail);
      } catch (e) {
        // Exchange's RBAC for Applications scope is the tenant's fence; say that, not "403".
        // Reworded, never re-typed: the status and `Retry-After` are what the platform's retry
        // reads (#2102), so the new error keeps both.
        if (e instanceof GraphError && e.status === 403) {
          throw new GraphError(
            403,
            e.code,
            `Exchange refused to send as '${mail.from.email}' — the address is outside the scope the tenant ` +
              `granted this app (RBAC for Applications), or the grant has not taken effect yet`,
          );
        }
        if (e instanceof GraphError && e.status === 429) {
          throw new GraphError(
            429,
            e.code,
            'Exchange is throttling this mailbox (about 30 messages a minute) — try again shortly',
            e.retryAfter,
          );
        }
        throw e;
      }
    },
  };
}

// ── internals ────────────────────────────────────────────────────────────────

function probeOf(p: {
  ok: boolean;
  refused?: boolean;
  error?: string;
  accountRef?: string | null;
  accountLabel?: string | null;
  facts?: { label: string; value: string }[];
}): ConnectionProbe {
  return {
    ok: p.ok,
    refused: p.refused ?? false,
    accountRef: p.accountRef?.slice(0, 200) ?? null,
    accountLabel: p.accountLabel?.slice(0, 200) ?? null,
    facts: p.facts ?? [],
    error: p.error?.slice(0, 600) ?? null,
  };
}

const mask = (value: string): string => (value.length < 8 ? '••••••••' : `••••••••${value.slice(-4)}`);
