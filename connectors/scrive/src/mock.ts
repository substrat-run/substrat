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
  parties: { id: string; name: string; signTime: string | null; auth: string }[];
}

export interface ScriveMockOptions {
  /** Reject every call with this HTTP status — the failure path on demand. */
  failWith?: number;
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

  constructor(options: ScriveMockOptions = {}) {
    this.failWith = options.failWith;
    this.onCallback = options.onCallback;
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
          doc.parties = patch.parties.map((p, i) => ({
            id: `party-${i}`,
            name: String(p.fields.find((f) => f.type === 'name')?.value ?? ''),
            signTime: null,
            auth: p.authentication_method_to_sign,
          }));
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
        doc.status = 'pending';
        return respond(200, this.wire(doc));
      }
      return respond(200, this.wire(doc));
    };
  }
}
