import type { FetchLike } from '@substrat-run/kernel';

/**
 * Scrive, in memory.
 *
 * ## What this is for
 *
 * A connector cannot be exercised end to end without a provider, and a provider
 * account is not always available. This implements the documented endpoints so
 * the seam — credential resolution, egress, health, retry, the document
 * lifecycle — can be tested today.
 *
 * ## What it proves, and what it does not
 *
 * It proves OUR shape works. It cannot prove our reading of Scrive's API is
 * right, because it *is* our reading of Scrive's API: same author, same
 * misunderstandings, in both halves. A green suite here means "ready to check
 * against a testbed account", never "verified".
 *
 * The specific things a mock like this will always get wrong until someone runs
 * the real thing: auth handshakes, exact response shapes, error bodies, rate
 * limits, and every asynchronous timing behaviour that matters.
 *
 * It stays useful afterwards: a real provider will not return 503 on demand, or
 * let you fast-forward two days to a signature.
 */

interface MockDocument {
  id: string;
  status: 'preparation' | 'pending' | 'closed' | 'canceled' | 'timedout' | 'rejected';
  title: string;
  callbackUrl: string | null;
  file: { name: string; bytes: number } | null;
  parties: {
    id: string;
    name: string;
    signTime: string | null;
    auth: string;
    /** Whether `update` carried a `personal_number` field — value irrelevant (#687). */
    hasPersonalNumber: boolean;
    /** The `email` field's value, or null when the party carried none. */
    email: string | null;
    /** The sending account. Scrive never invites it, so it needs no address. */
    isAuthor: boolean;
  }[];
}

export interface ScriveMockOptions {
  /** Reject every call with this HTTP status — the failure path on demand. */
  failWith?: number;
  /**
   * Validate `start`'s DELIVERY rule as the real testbed does: a party who must
   * be INVITED and carries no `email` field cannot be reached, and `start`
   * answers 409 `invalid_invitation_delivery_info` (probed live, #687).
   *
   * The author is exempt — it is the sending account, and Scrive never invites
   * it. That exemption is the whole shape of the bug: because this connector
   * sends no address on any party, a set with a real counterparty is refused
   * loudly, while a set whose only party is the author STARTS and delivers to
   * nobody. Production reached the second case without anyone choosing it.
   *
   * Default OFF: no party this connector builds carries an address, so enforcing
   * the rule by default would fail every dispatch test with a gap none of them is
   * about. `test/dispatch.test.ts` turns it on for the two tests that state the
   * gap — the refusal AND the control case that starts. When a party can carry a
   * contact (#687 item 1), this option should become the behaviour and disappear.
   */
  strictDelivery?: boolean;
  /**
   * Fired when a signing event lands on a document that has an
   * `api_callback_url` — the provider-side POST the real Scrive makes on status
   * changes. The mock only reports WHERE (the capability URL the connector set)
   * and what document, never a trustworthy body, matching the real callback's
   * standing as a hint. Errors are swallowed, as a provider's delivery failures
   * would be — the poll floor is what covers a lost callback.
   */
  onCallback?: (cb: { url: string; documentId: string; status: string }) => void | Promise<void>;
}

// URL and TextEncoder are web-standard everywhere this runs; declared locally so
// the connector pulls in no platform typings, exactly as the kernel does.
declare const URL: new (input: string) => { pathname: string };
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

export class ScriveMock {
  readonly documents = new Map<string, MockDocument>();
  private seq = 0;
  failWith: number | undefined;
  private readonly onCallback: ScriveMockOptions['onCallback'];
  private readonly strictDelivery: boolean;

  constructor(options: ScriveMockOptions = {}) {
    this.failWith = options.failWith;
    this.onCallback = options.onCallback;
    this.strictDelivery = options.strictDelivery ?? false;
  }

  /** Simulate a party completing BankID. The provider-side event we cannot cause for real. */
  sign(documentId: string, partyIndex: number, at: string): void {
    const doc = this.mustGet(documentId);
    const party = doc.parties[partyIndex];
    if (!party) throw new Error(`mock: no party ${partyIndex} on ${documentId}`);
    party.signTime = at;
    // Scrive closes a document only when EVERY party has signed — the same rule
    // engine-protocol applies to its own request set, arrived at independently.
    if (doc.parties.every((p) => p.signTime)) doc.status = 'closed';
    this.fireCallback(doc);
  }

  decline(documentId: string): void {
    const doc = this.mustGet(documentId);
    doc.status = 'rejected';
    this.fireCallback(doc);
  }

  /** The provider-side POST on a signing event — fire and forget, like the real one. */
  private fireCallback(doc: MockDocument): void {
    if (!doc.callbackUrl || !this.onCallback) return;
    void Promise.resolve(
      this.onCallback({ url: doc.callbackUrl, documentId: doc.id, status: doc.status }),
    ).catch(() => {});
  }

  private mustGet(id: string): MockDocument {
    const doc = this.documents.get(id);
    if (!doc) throw new Error(`mock: unknown document ${id}`);
    return doc;
  }

  private wire(doc: MockDocument) {
    return {
      id: doc.id,
      status: doc.status,
      title: doc.title,
      parties: doc.parties.map((p) => ({
        id: p.id,
        sign_time: p.signTime,
        fields: [{ type: 'name', value: p.name }],
      })),
    };
  }

  /** The `fetch` to hand a host. */
  get fetch(): FetchLike {
    return (url, init) => {
      const respond = (status: number, body: unknown) =>
        Promise.resolve({
          ok: status >= 200 && status < 300,
          status,
          text: () => Promise.resolve(JSON.stringify(body)),
          json: () => Promise.resolve(body),
          arrayBuffer: () =>
            Promise.resolve(new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer),
        });
      const respondBytes = (bytes: Uint8Array) =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(''),
          json: () => Promise.reject(new Error('mock: binary body is not JSON')),
          arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0) as ArrayBuffer),
        });

      if (this.failWith) return respond(this.failWith, { error_message: 'mock failure' });
      // OAuth1 PLAINTEXT, matching the real testbed: the connector sends an
      // `authorization` header starting `oauth_signature_method="PLAINTEXT"`.
      // A `Bearer` header (the old, wrong scheme) must NOT authenticate here, or
      // the mock would keep passing a shape the real API rejects.
      const auth = init?.headers?.authorization ?? init?.headers?.Authorization ?? '';
      if (!auth.includes('oauth_signature_method="PLAINTEXT"')) {
        return respond(401, { error_message: 'No valid access credentials were provided.' });
      }

      const path = new URL(url).pathname;

      // The probe's read (#605). Shaped after the real testbed response, down to the
      // company object `externalAccountRef` is drawn from — the fields the connector
      // parses and nothing else, because a mock that invents fields teaches nothing.
      if (path === '/api/v2/getprofile') {
        return respond(200, {
          id: '211338',
          fstname: 'Mock',
          sndname: 'Operator',
          email: 'mock@substrat.test',
          role: 'role_account_owner',
          company: { companyid: '30338661', companyname: 'Mock Company' },
        });
      }

      // The account's documents, newest first — the live half of the activity view.
      if (path === '/api/v2/documents/list') {
        const documents = [...this.documents.values()].reverse().map((d) => ({
          id: d.id,
          title: d.title,
          status: d.status,
          ctime: '2026-08-01T10:00:00Z',
          mtime: '2026-08-01T10:05:00Z',
        }));
        return respond(200, { total_matching: documents.length, documents });
      }

      if (path === '/api/v2/documents/new') {
        this.seq += 1;
        const doc: MockDocument = {
          id: `doc-${this.seq}`,
          status: 'preparation',
          title: '',
          callbackUrl: null,
          file: null,
          parties: [],
        };
        this.documents.set(doc.id, doc);
        return respond(200, this.wire(doc));
      }

      const main = /^\/api\/v2\/documents\/([^/]+)\/files\/main$/.exec(path);
      if (main) {
        const doc = this.documents.get(main[1]!);
        if (!doc) return respond(404, { error_message: `mock: unknown document ${main[1]}` });
        // Scrive holds no sealed file until a document has one; refuse the fetch
        // the same way, so a caller that pulls before the file exists fails here.
        if (!doc.file) return respond(409, { error_message: 'mock: document has no file' });
        // The bytes carry the id and status so a test can prove it pulled THIS
        // document's sealed copy — the real API returns the signed PDF.
        return respondBytes(new TextEncoder().encode(`%PDF sealed ${doc.id} ${doc.status}`));
      }

      const m = /^\/api\/v2\/documents\/([^/]+)\/(setfile|update|start|get)$/.exec(path);
      if (!m) return respond(404, { error: `mock: no route for ${path}` });
      const [, id, action] = m;
      const doc = this.documents.get(id!);
      if (!doc) return respond(404, { error: `mock: unknown document ${id}` });

      if (action === 'setfile') {
        // The real body is multipart/form-data bytes (a Uint8Array), not a
        // string — the length is all the mock needs to know a file arrived.
        const size = typeof init?.body === 'string' ? init.body.length : (init?.body?.length ?? 0);
        doc.file = { name: 'document.pdf', bytes: size };
        return respond(200, this.wire(doc));
      }
      if (action === 'update') {
        // The real API takes `document=<url-encoded JSON>` as a form field, not a
        // JSON request body — the mock parses it the same way so the connector's
        // encoding is under test.
        const raw = typeof init?.body === 'string' ? init.body : '';
        const encoded = /(?:^|&)document=([^&]*)/.exec(raw)?.[1] ?? '';
        const patch = JSON.parse(decodeURIComponent(encoded) || '{}') as {
          title?: string;
          api_callback_url?: string;
          tags?: { name: string; value: string }[];
          parties?: {
            is_author?: boolean;
            is_signatory?: boolean;
            authentication_method_to_sign: string;
            fields: { type: string; value: unknown }[];
          }[];
        };
        if (patch.title) doc.title = patch.title;
        if (patch.api_callback_url) doc.callbackUrl = patch.api_callback_url;
        if (patch.parties) {
          const authors = patch.parties.filter((p) => p.is_author).length;
          if (authors !== 1) {
            // Scrive requires exactly one author across the party set. The mock
            // enforces it so a regression in the connector's party mapping fails
            // here rather than silently against the real API.
            return respond(400, { error_message: `exactly one author required, got ${authors}` });
          }
          doc.parties = patch.parties.map((p, i) => {
            const email = p.fields.find((f) => f.type === 'email')?.value;
            return {
              id: `party-${i}`,
              name: String(p.fields.find((f) => f.type === 'name')?.value ?? ''),
              signTime: null,
              auth: p.authentication_method_to_sign,
              // Presence, not value — that is exactly the rule `start` applies.
              hasPersonalNumber: p.fields.some((f) => f.type === 'personal_number'),
              email: email === undefined ? null : String(email),
              isAuthor: p.is_author === true,
            };
          });
        }
        return respond(200, this.wire(doc));
      }
      if (action === 'start') {
        if (!doc.file) {
          // The constraint that forced the whole PDF question: Scrive signs a
          // file, and refuses to start without one.
          return respond(409, { error: 'mock: cannot start a document with no file' });
        }
        if (doc.parties.length === 0) return respond(409, { error: 'mock: no parties' });

        // The two `start` rules probed against the real testbed (#687). Scrive
        // answers with a LIST of errors and a leading `error_message`; the shape is
        // reproduced because the connector's readable-failure path (#618) shows
        // that text to an operator verbatim.
        const errors: { type: string; details: Record<string, unknown> }[] = [];
        doc.parties.forEach((p, i) => {
          // BankID-to-sign needs the FIELD; an empty value satisfies it, and the
          // signatory fills it in at signing time.
          if (p.auth === 'se_bankid' && !p.hasPersonalNumber) {
            errors.push({
              type: 'invalid_authentication_to_sign_info',
              details: { field: { type: 'personal_number' }, participant: i + 1 },
            });
          }
          // The author is the sending account: Scrive has nobody to invite it TO,
          // so it needs no address and this rule does not reach it. Production
          // proved the exemption the hard way — a document whose only party was
          // the author STARTED, reported itself sent, and invited nobody
          // (#687 comment; Scrive doc 9222115557586247373). Applying the rule to
          // every party would make the mock refuse the one case that must not be
          // refused, and hide the case that actually hurts.
          if (this.strictDelivery && !p.isAuthor && !p.email) {
            errors.push({
              type: 'invalid_invitation_delivery_info',
              details: { field: { type: 'email' }, participant: i + 1 },
            });
          }
        });
        if (errors.length > 0) {
          const explain = (e: (typeof errors)[number]) =>
            e.type === 'invalid_authentication_to_sign_info'
              ? `Authentication to sign for participant #${String(e.details.participant)} requires valid personal number field.`
              : `Invitation delivery for participant #${String(e.details.participant)} requires valid email field.`;
          return respond(409, {
            error_details: { document_id: doc.id, errors, explanations: errors.map(explain) },
            error_message: explain(errors[0]!),
            error_type: 'document_state_error',
            http_code: 409,
          });
        }

        doc.status = 'pending';
        return respond(200, this.wire(doc));
      }
      return respond(200, this.wire(doc));
    };
  }
}
