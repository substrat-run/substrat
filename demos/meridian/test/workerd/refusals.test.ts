/**
 * An operation name the caller chose is answered as a 404 `not_found` problem, whatever it says.
 *
 * `problemResponse` reads a platform-fault phrase in a message before it reads the code, so a name
 * such as `transient error` would come back 502 if the route answered through it. The route is
 * decided before any caller or scope is resolved, so no router assertion is needed.
 */
import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('keeps a decided 404 for an operation name that reads like a platform fault', async () => {
  const res = await SELF.fetch('https://meridian.test/api/op/transient%20error', { method: 'POST' });
  expect(res.status).toBe(404);
  expect(res.headers.get('content-type')).toContain('application/problem+json');
  expect(await res.json()).toMatchObject({ code: 'not_found', detail: 'unknown operation: transient error' });
});
