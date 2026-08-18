import { z } from 'zod';
import type { ConnectorConnection } from '@substrat-run/kernel';

// Web-standard everywhere this runs (Node, Workers); declared locally so the
// connector pulls in no platform typings, exactly as the kernel does.
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

/**
 * A thin, typed client over the Scrive eSign v2 endpoints.
 *
 * Every call goes through the connection's `fetch`, never a global one: that is
 * what gets it a timeout, an egress policy, and health recorded against the
 * right connection. Module code cannot reach any of this — boundary-lint bans
 * `fetch` outright — and a connector is host code.
 *
 * **The shapes here were verified against `api-testbed.scrive.com`, not just the
 * docs.** The first version of this file was written from the documentation and
 * was wrong in three ways a live call exposed at once (auth scheme, the upload
 * encoding, the create-response shape). Each is called out below where it bit.
 */

export const SCRIVE_TESTBED = 'https://api-testbed.scrive.com';
export const SCRIVE_PRODUCTION = 'https://scrive.com';

/**
 * A Scrive connection's credential — OAuth1 "personal access credentials".
 *
 * NOT OAuth2 bearer, which the first version assumed. Scrive's UI labels these
 * "Client credentials" and "Token credentials", which reads like two schemes but
 * is one: the four parts combine into a PLAINTEXT OAuth signature. The
 * `oauth2.scrive.com` token endpoint rejects them with `invalid_client` — it is
 * a different mechanism entirely.
 */
export const scriveSecret = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  tokenId: z.string().min(1),
  tokenSecret: z.string().min(1),
});
export type ScriveSecret = z.infer<typeof scriveSecret>;

/**
 * An id-bearing response — what `new` / `setfile` / `update` / `start` return.
 *
 * `POST /documents/new` returns NO top-level `status` (verified) — only
 * `/documents/{id}/get` returns the full object. The first version parsed every
 * response as a full document and would have thrown on call one. So mutation
 * responses are parsed for their id only, and status is read from `get` — which
 * is the right design anyway: don't trust a mutation's echo, re-read the truth.
 */
export const scriveDocRef = z.object({ id: z.string().min(1) });
export type ScriveDocRef = z.infer<typeof scriveDocRef>;

/** The full document, as `get` returns it — extra fields ignored. */
export const scriveDocument = z.object({
  id: z.string().min(1),
  status: z.enum(['preparation', 'pending', 'closed', 'canceled', 'timedout', 'rejected']),
  parties: z
    .array(
      z.object({
        id: z.string().min(1),
        is_author: z.boolean().optional(),
        is_signatory: z.boolean().optional(),
        signatory_role: z.string().optional(),
        /** Set once that party has signed. */
        sign_time: z.string().nullable().optional(),
        authentication_method_to_sign: z.string().optional(),
        /**
         * The party's fields — read by the poll driver to cross-check that the
         * provider's Nth party is still the dispatch's Nth party (name), before
         * attributing a signature to a request. Kept so the reconcile can fail
         * closed on a reorder rather than mis-record.
         */
        fields: z
          .array(z.object({ type: z.string(), value: z.unknown() }))
          .optional(),
      }),
    )
    .default([]),
});
export type ScriveDocument = z.infer<typeof scriveDocument>;

/**
 * The API user and the company it acts for — `GET /api/v2/getprofile`, the cheapest
 * authenticated read Scrive offers and therefore the probe (#605).
 *
 * Verified against the testbed: the endpoint is `/api/v2/getprofile`, NOT
 * `/api/v2/user/getprofile` (404), and a bad credential answers `401` with a
 * **plain-text** body rather than Scrive's usual JSON error envelope — which
 * {@link asJson} already handles by keeping the raw slice, so the operator reads
 * "No valid access credentials were provided" instead of a bare status.
 *
 * `company.companyid` is what `externalAccountRef` means for this provider, which is
 * what lets a probe answer "these keys are for a different Scrive account than the one
 * this connection was made for". Extra fields ignored — the response carries a large
 * company-settings object this deliberately does not learn.
 */
export const scriveProfile = z.object({
  id: z.string().min(1),
  email: z.string().default(''),
  fstname: z.string().default(''),
  sndname: z.string().default(''),
  /** 'role_account_owner', 'role_account_admin', … — shown, never interpreted. */
  role: z.string().optional(),
  company: z
    .object({ companyid: z.string().min(1), companyname: z.string().default('') })
    .optional(),
});
export type ScriveProfile = z.infer<typeof scriveProfile>;

/**
 * One row of `GET /api/v2/documents/list` — the account's documents, newest first.
 *
 * Only the fields a console shows are parsed; the full row carries ~40 more. This is
 * the LIVE view: the dispatch ledger knows what the platform sent, this knows what the
 * provider currently holds, and the two answer different questions.
 */
export const scriveDocumentSummary = z.object({
  id: z.string().min(1),
  title: z.string().default(''),
  status: z.string().min(1),
  ctime: z.string().optional(),
  mtime: z.string().optional(),
});
export type ScriveDocumentSummary = z.infer<typeof scriveDocumentSummary>;

export const scriveDocumentList = z.object({
  total_matching: z.number().int().nonnegative().default(0),
  documents: z.array(scriveDocumentSummary).default([]),
});
export type ScriveDocumentList = z.infer<typeof scriveDocumentList>;

export interface ScriveParty {
  /** Display name for the signing page. */
  name: string;
  email?: string;
  /**
   * Mobile number for an SMS invitation (#687).
   *
   * Beside `email` rather than instead of it because the engine's `partyContact`
   * carries either, and a party reachable only by phone is a party this connector
   * would otherwise have to refuse. Passed through to the provider's `mobile`
   * field and, like the address above, never persisted by us.
   */
  mobile?: string;
  /**
   * Swedish personnummer, when the sender happens to know it.
   *
   * **Optional even for BankID**, which is the whole finding of
   * [#687](https://github.com/substrat-run/substrat/issues/687): what Scrive
   * validates on `start` is that the party *has* a `personal_number` field, not
   * that it holds a value. `update` below therefore sends an EMPTY one for every
   * `se_bankid` party, and the signatory completes it at signing time.
   *
   * When it is supplied it is passed THROUGH to the provider and never persisted
   * by us: it is `direct` PII, and `engine-protocol` stores an opaque
   * `DataSubjectId` as the signatory instead. The provider needs it; our tables
   * must not have it.
   */
  personalNumber?: string;
  /** `se_bankid` for Swedish BankID; `standard` otherwise. */
  authenticationMethodToSign: 'standard' | 'se_bankid';
  /**
   * The sender/author. Scrive auto-adds the API user as an author party on
   * `new`; exactly one party across the set must be the author, so the connector
   * marks the issuing (primary) party as it. Verified: sending an explicit
   * author party in `update` replaces the auto one.
   */
  isAuthor?: boolean;
  /** A viewer rather than a signer — an author who does not sign. */
  isSignatory?: boolean;
}

/**
 * A provider response that was not 2xx, carrying the STATUS as data.
 *
 * The status is the difference between two failures that must not be conflated: a
 * `401`/`403` is Scrive saying "not with these credentials" — a definite answer about the
 * credential — while a timeout, a 5xx or a DNS failure says nothing about it at all.
 * A caller that cannot tell them apart must either reject good credentials during a
 * provider outage or accept bad ones; both are worse than asking.
 */
export class ScriveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ScriveApiError';
  }

  /** The provider refused the CREDENTIAL, as opposed to failing for its own reasons. */
  get refused(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

const asJson = async (
  res: { ok: boolean; status: number; text(): Promise<string> },
  what: string,
) => {
  const body = await res.text();
  if (!res.ok) {
    // Scrive's error body is JSON with `error_message`; surface it rather than a
    // bare status, because "This feature is disabled" is the difference between a
    // bug and an account setting.
    //
    // `start` can fail for SEVERAL reasons at once and reports them in
    // `error_details.explanations`, of which `error_message` is only the first —
    // so a document blocked by both a missing field and an account setting used to
    // read as one problem, and fixing it produced the next single sentence (#687).
    // Every explanation is joined, because the operator reading this through the
    // delivery-attempt history (#618) has no other way to see the rest.
    let detail = body.slice(0, 400);
    try {
      const parsed = JSON.parse(body) as {
        error_message?: string;
        error_details?: { explanations?: string[] };
      };
      const all = parsed.error_details?.explanations ?? [];
      if (all.length > 1) detail = all.join(' ');
      else if (parsed.error_message) detail = parsed.error_message;
    } catch {
      /* not JSON; keep the raw slice */
    }
    throw new ScriveApiError(`scrive ${what} failed: HTTP ${res.status} ${detail}`, res.status);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`scrive ${what}: response was not JSON (${body.slice(0, 200)})`);
  }
};

/**
 * Read a binary response as bytes. The success body IS the file — reading it as
 * text would corrupt the PDF — but a non-2xx body is still Scrive's JSON error,
 * surfaced identically to {@link asJson} so a disabled feature or a missing file
 * reads the same everywhere.
 */
const asBytes = async (
  res: {
    ok: boolean;
    status: number;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  },
  what: string,
): Promise<Uint8Array> => {
  if (!res.ok) {
    const body = await res.text();
    let detail = body.slice(0, 400);
    try {
      const parsed = JSON.parse(body) as { error_message?: string };
      if (parsed.error_message) detail = parsed.error_message;
    } catch {
      /* not JSON; keep the raw slice */
    }
    throw new ScriveApiError(`scrive ${what} failed: HTTP ${res.status} ${detail}`, res.status);
  }
  return new Uint8Array(await res.arrayBuffer());
};

export class ScriveApi {
  private readonly secret: ScriveSecret;

  constructor(
    private readonly conn: ConnectorConnection,
    private readonly baseUrl: string = SCRIVE_TESTBED,
  ) {
    this.secret = scriveSecret.parse(conn.secret);
  }

  /**
   * The OAuth1 PLAINTEXT authorization header. The signature is
   * `<clientSecret>&<tokenSecret>` — literally the two secrets joined by `&`,
   * which is what "PLAINTEXT" means: no HMAC, TLS is the confidentiality.
   */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const s = this.secret;
    const auth =
      `oauth_signature_method="PLAINTEXT", ` +
      `oauth_consumer_key="${s.clientId}", ` +
      `oauth_token="${s.tokenId}", ` +
      `oauth_signature="${s.clientSecret}&${s.tokenSecret}"`;
    return { authorization: auth, ...extra };
  }

  /**
   * Who these credentials are — the probe (#605). Cheap, read-only, and the only call
   * that names the ACCOUNT rather than a document, which is what makes it the right
   * answer to "did I paste the right keys, and for which company?".
   */
  async getProfile(): Promise<ScriveProfile> {
    const res = await this.conn.fetch(`${this.baseUrl}/api/v2/getprofile`, {
      method: 'GET',
      headers: this.headers(),
    });
    return scriveProfile.parse(await asJson(res, 'getprofile'));
  }

  /**
   * The account's documents, newest first — the live counterpart to the dispatch
   * ledger. Bounded by `max` (Scrive's own default is small; the console asks for a
   * page, never the archive) and used to join the provider's CURRENT status onto the
   * rows the platform recorded sending.
   */
  async listDocuments(opts: { max?: number; offset?: number } = {}): Promise<ScriveDocumentList> {
    const max = opts.max ?? 100;
    const offset = opts.offset ?? 0;
    const res = await this.conn.fetch(
      `${this.baseUrl}/api/v2/documents/list?offset=${offset}&max=${max}`,
      { method: 'GET', headers: this.headers() },
    );
    return scriveDocumentList.parse(await asJson(res, 'documents/list'));
  }

  async createDocument(): Promise<ScriveDocRef> {
    const res = await this.conn.fetch(`${this.baseUrl}/api/v2/documents/new`, {
      method: 'POST',
      headers: this.headers(),
    });
    return scriveDocRef.parse(await asJson(res, 'documents/new'));
  }

  /**
   * Attach the PDF. **`multipart/form-data`**, verified — not the raw base64 body
   * the first version sent. The multipart envelope is built as bytes because the
   * file is binary and a string body would corrupt it (which is why
   * `ConnectorRequestInit.body` accepts `Uint8Array`).
   */
  async setFile(documentId: string, filename: string, pdf: Uint8Array): Promise<void> {
    const boundary = `----substrat${filename.length}${pdf.length}`;
    const body = multipartFile(boundary, 'file', filename, pdf);
    const res = await this.conn.fetch(`${this.baseUrl}/api/v2/documents/${documentId}/setfile`, {
      method: 'POST',
      headers: this.headers({ 'content-type': `multipart/form-data; boundary=${boundary}` }),
      body,
    });
    await asJson(res, 'setfile');
  }

  /** Parties, callback URL and title, in one `document=` form field. */
  async update(
    documentId: string,
    patch: {
      title?: string;
      parties?: ScriveParty[];
      callbackUrl?: string;
      tags?: { name: string; value: string }[];
    },
  ): Promise<ScriveDocRef> {
    const document = {
      ...(patch.title ? { title: patch.title } : {}),
      ...(patch.callbackUrl ? { api_callback_url: patch.callbackUrl } : {}),
      ...(patch.tags ? { tags: patch.tags } : {}),
      ...(patch.parties
        ? {
            parties: patch.parties.map((p) => ({
              is_author: p.isAuthor ?? false,
              is_signatory: p.isSignatory ?? true,
              authentication_method_to_sign: p.authenticationMethodToSign,
              fields: [
                { type: 'name', order: 1, value: p.name },
                ...(p.email ? [{ type: 'email', value: p.email }] : []),
                ...(p.mobile ? [{ type: 'mobile', value: p.mobile }] : []),
                // BankID-to-sign needs the FIELD, not a value (#687). Probed
                // against the testbed: a party carrying `personal_number: ''`
                // draws exactly the same `start` errors as one carrying a real
                // personnummer, and a party carrying no such field draws
                // `invalid_authentication_to_sign_info` on top of them. So the
                // empty field is what makes `strong` dispatchable at all, and
                // the signatory fills it in during the BankID ceremony.
                //
                // No flags: Scrive stores every field `is_obligatory: true,
                // should_be_filled_by_sender: false` by default, which is
                // already what this wants — verified by reading the party back
                // from `get` after `update`.
                ...(p.authenticationMethodToSign === 'se_bankid' || p.personalNumber
                  ? [{ type: 'personal_number', value: p.personalNumber ?? '' }]
                  : []),
              ],
            })),
          }
        : {}),
    };
    // Scrive takes the document JSON as a url-encoded `document=` form field, not
    // a JSON request body — another shape the docs left ambiguous and the testbed
    // settled.
    const res = await this.conn.fetch(`${this.baseUrl}/api/v2/documents/${documentId}/update`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      body: `document=${encodeURIComponent(JSON.stringify(document))}`,
    });
    return scriveDocRef.parse(await asJson(res, 'update'));
  }

  /** Send it. After this the document is `pending` and the parties are invited. */
  async start(documentId: string): Promise<ScriveDocRef> {
    const res = await this.conn.fetch(`${this.baseUrl}/api/v2/documents/${documentId}/start`, {
      method: 'POST',
      headers: this.headers(),
    });
    return scriveDocRef.parse(await asJson(res, 'start'));
  }

  /**
   * Current state — the polling path, and the only call that returns `status`.
   * Webhook ingress (#96) is not on the critical path precisely because this
   * exists and Scrive's callbacks are unauthenticated anyway.
   */
  async get(documentId: string): Promise<ScriveDocument> {
    const res = await this.conn.fetch(`${this.baseUrl}/api/v2/documents/${documentId}/get`, {
      method: 'GET',
      headers: this.headers(),
    });
    return scriveDocument.parse(await asJson(res, 'get'));
  }

  /**
   * The sealed signed PDF — Scrive's own copy with the signing evidence attached,
   * the thing a customer, a dispute, or an auditor actually asks for.
   *
   * `GET /api/v2/documents/{id}/files/main` returns the bytes directly, so this is
   * the one call that reads the response as an ArrayBuffer rather than JSON. The
   * sealed file exists only once the document is `closed`; on an open document the
   * response is the working copy or an error depending on account settings, so the
   * return path fetches only after `get` reports `closed` (issue #476).
   */
  async getMainFile(documentId: string): Promise<Uint8Array> {
    const res = await this.conn.fetch(
      `${this.baseUrl}/api/v2/documents/${documentId}/files/main`,
      { method: 'GET', headers: this.headers() },
    );
    return asBytes(res, 'files/main');
  }
}

/** A one-file `multipart/form-data` body, as bytes. Web-standard, no node:buffer. */
function multipartFile(
  boundary: string,
  field: string,
  filename: string,
  file: Uint8Array,
): Uint8Array {
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
      `content-disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `content-type: application/pdf\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + file.length + tail.length);
  out.set(head, 0);
  out.set(file, head.length);
  out.set(tail, head.length + file.length);
  return out;
}
