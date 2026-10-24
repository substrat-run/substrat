import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { scopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { mountPlatformSurface, type VerticalScopeHost } from '@substrat-run/vertical-host';
import { ControlPlaneError, VerticalClient } from '../src/index.js';

/**
 * A scope's attachment bytes (#2501), read by the platform through the deployment that holds the
 * scope. The client is held to the route that answers it (`mountPlatformSurface`), not to a
 * fixture of it: the path, the one `/internal/*` gate, and the 501 an older deployment answers.
 * The answer lands in a sum, so anything that is not a size must throw rather than read as 0.
 */

const s = scopeId.parse(ulid());
const SECRET = 'attachment-size-secret';
type Env = { PLATFORM_SECRET: string };

function deployment(host: Partial<VerticalScopeHost>, secret = SECRET) {
  const app = new Hono<{ Bindings: Env }>();
  mountPlatformSurface<Env>(app, {
    platformSecret: (env) => env.PLATFORM_SECRET,
    hostFor: () => host as VerticalScopeHost,
    roles: [],
    ownerRoleKey: 'admin',
  });
  return new VerticalClient({
    fetch: ((input: RequestInfo, init?: RequestInit) => app.request(input, init, { PLATFORM_SECRET: SECRET })) as typeof fetch,
    platformSecret: secret,
  });
}

describe('VerticalClient ↔ mountPlatformSurface — attachment size (#2501)', () => {
  it("asks the deployment's route for the scope, and reads what its host sums", async () => {
    const asked: string[] = [];
    const client = deployment({ attachmentSizeLocal: async (scope) => (asked.push(scope), 4_096) });
    await expect(client.attachmentSize(s)).resolves.toBe(4_096);
    expect(asked).toEqual([s]);
  });

  it('a deployment whose host cannot read them answers 501, and the client throws it, never 0', async () => {
    const err = await deployment({}).attachmentSize(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err).toMatchObject({ status: 501 });
  });

  it('sits behind the same gate as its siblings: the wrong platform secret is refused', async () => {
    let read = 0;
    const err = await deployment({ attachmentSizeLocal: async () => ((read += 1), 1) }, 'not-the-secret')
      .attachmentSize(s)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403 });
    expect(read).toBe(0);
  });
});

describe('VerticalClient — attachment size answers (#2501)', () => {
  const answering = (status: number, body: string, seen: string[] = []) =>
    new VerticalClient({
      fetch: (async (input: string) => {
        seen.push(input);
        return new Response(body, { status });
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });

  it('asks the attachment-size route for the scope and reads `bytes`', async () => {
    const seen: string[] = [];
    await expect(answering(200, JSON.stringify({ bytes: 0 }), seen).attachmentSize(s)).resolves.toBe(0);
    expect(new URL(seen[0]!).pathname).toBe('/internal/attachment-size');
    expect(new URL(seen[0]!).searchParams.get('scopeId')).toBe(s);
  });

  it('a 200 without a size is a wire disagreement, not a zero', async () => {
    for (const body of [{}, { bytes: '8192' }, { bytes: -1 }, { bytes: 1.5 }]) {
      await expect(answering(200, JSON.stringify(body)).attachmentSize(s)).rejects.toThrow(/attachment-size without a size/);
    }
  });

  it('a route miss carries its raw body, so the platform can tell it from an enveloped 404', async () => {
    const miss = (await answering(404, '404 Not Found').attachmentSize(s).catch((e: unknown) => e)) as ControlPlaneError;
    expect(miss).toMatchObject({ status: 404, body: '404 Not Found' });
  });
});
