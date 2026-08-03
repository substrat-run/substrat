import type { FetchLike } from '@substrat-run/kernel';

/**
 * An in-memory provider, so a connector can be exercised end to end without any
 * real API credentials.
 *
 * This is how a connector gets tested at all before a vendor account exists —
 * and it stays useful afterwards, because a real provider will not produce a
 * 503 on demand.
 *
 * What it proves: that the SEAM works — credential resolution, egress, health
 * recording, retry. What it cannot prove: that our reading of any vendor's API
 * is correct. A mock encodes the author's understanding of the docs, so a green
 * suite here means "ready to check against reality", never "verified".
 */
export interface ConnectorCall {
  url: string;
  method: string | undefined;
  auth: string | undefined;
  body: string | Uint8Array | undefined;
}

export const connectorCalls: ConnectorCall[] = [];

export const resetConnectorCalls = (): void => {
  connectorCalls.length = 0;
};

/** Fails with 503 when the request body mentions `fail` — the error path on demand. */
export const connectorTestFetch: FetchLike = (url, init) => {
  connectorCalls.push({
    url,
    method: init?.method,
    auth: init?.headers?.Authorization,
    body: init?.body,
  });
  // Body may now be bytes (a real upload); only a string body carries the 'fail'
  // marker the tests use to trigger the error path.
  const failing = typeof init?.body === 'string' && init.body.includes('fail');
  return Promise.resolve({
    ok: !failing,
    status: failing ? 503 : 200,
    text: () => Promise.resolve('{}'),
    json: () => Promise.resolve({}),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  });
};
