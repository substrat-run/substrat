import { describe, it, expect } from 'vitest';
import { PROBLEM_CONTENT_TYPE, connectionId, errorCodeOf, problemTypeFor, scopeId, tenantId } from '@substrat-run/contracts';
import { bindConnection, mailInAddress, mintConnectLink, requestConnectUrl } from '../src/index.js';

/**
 * #113: the platform's relay refusals carry a taxonomy `code`, and each harness reader exposes it
 * as `problemCode` beside the status and sentence it always kept. Against an older control plane
 * (a bare `{ error }`) the reader still has the sentence and simply no code, and a `code` outside
 * the closed taxonomy is never exposed. The error never reads as one that declared itself here
 * (`errorCodeOf` is `undefined`), so a vertical's own `onError` answers it as it did before.
 */
const ids = {
  tenantId: tenantId.parse('01J0000000000000000000TENA'),
  scopeId: scopeId.parse('01J0000000000000000000SCPA'),
};
const access = { controlPlaneUrl: 'https://cp.example', platformSecret: 'platform-secret', ...ids };

const answering = (status: number, body: unknown, contentType = 'application/json') =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } })) as typeof fetch;

const readers: [string, (fetchImpl: typeof fetch) => Promise<unknown>][] = [
  ['connections', (fetchImpl) => bindConnection({ ...access, connectionId: connectionId.parse('01J0000000000000000000CNNA'), boundBy: 'p', fetchImpl })],
  ['connect-url', (fetchImpl) => requestConnectUrl({ ...access, provider: 'fortnox', createdBy: 'p', fetchImpl })],
  ['connect-link', (fetchImpl) => mintConnectLink({ ...access, provider: 'fortnox', createdBy: 'p', fetchImpl })],
  ['mail-in', (fetchImpl) => mailInAddress({ ...access, action: 'get', fetchImpl })],
];

const sentence = 'scope has no vertical bound';
const refusal = (fetchImpl: typeof fetch, run: (f: typeof fetch) => Promise<unknown>) =>
  run(fetchImpl).then(
    () => expect.fail('expected a refusal'),
    (e: unknown) => e as Error & { status: number; problemCode?: string },
  );

describe('relay readers expose the refusal code as problemCode', () => {
  it.each(readers)('%s: a coded problem, an old { error }, and an unknown code', async (_, run) => {
    const coded = await refusal(
      answering(404, { type: problemTypeFor('not_found'), title: 'Not found', status: 404, detail: sentence, error: sentence, code: 'not_found' }, PROBLEM_CONTENT_TYPE),
      run,
    );
    expect(coded).toMatchObject({ status: 404, problemCode: 'not_found', message: expect.stringContaining(sentence) });
    expect(errorCodeOf(coded)).toBeUndefined();

    const old = await refusal(answering(404, { error: sentence }), run);
    expect(old).toMatchObject({ status: 404, message: expect.stringContaining(sentence) });
    expect(old.problemCode).toBeUndefined();

    const unknown = await refusal(answering(404, { detail: sentence, code: 'not_a_code' }, PROBLEM_CONTENT_TYPE), run);
    expect(unknown.message).toContain(sentence);
    expect(unknown.problemCode).toBeUndefined();
  });
});
