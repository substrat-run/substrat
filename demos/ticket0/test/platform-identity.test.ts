/**
 * The claim the PLATFORM APPS mint, verified by this desk.
 *
 * The console and the dashboard embed this widget with the signed-in user already
 * vouched for, and they sign that claim with `signVisitorIdentity` from
 * `@substrat-run/oidc-rp` — a different file, a different package, written for a
 * different reason than `signIdentity` in `src/seed.ts`. Both are HMAC-SHA-256 over
 * the external id, hex, and the whole embed rests on them producing the same bytes:
 * disagree about the encoding and `widget-start` refuses every platform visitor with
 * "signature does not verify", which reads exactly like a misconfigured secret.
 *
 * So the point of this file is the seam, and it is deliberately NOT asserted by
 * calling one implementation and comparing it to the other. It signs with the
 * platform's function and hands the result to the desk's real operation, because
 * that is the thing that has to be true.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signVisitorIdentity } from '@substrat-run/oidc-rp';
import type { ScopeHost } from '@substrat-run/kernel';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-platform-identity-'));
  host = buildHost(dir);
  world = await seed(host);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a platform app vouches for its signed-in user', () => {
  it('a claim signed by @substrat-run/oidc-rp is accepted, and the visitor is verified', async () => {
    const desk = world.substrat;
    const widget = await host.getScope(desk.widget.principal, desk.tenant, desk.scope);
    const email = 'staff@substrat.net';

    const started = (await widget.invoke('ticket0/widget-start', {
      origin: desk.origin,
      // Exactly what the console's and the dashboard's `/api/support/identity` puts
      // on the script tag: the session's own email, and this deployment's signature
      // over it. Nothing else — the desk learns who, never how they signed in.
      identity: {
        externalId: email,
        email,
        signature: await signVisitorIdentity(desk.verificationSecret, email),
      },
    })) as { sessionId: string; verified: boolean };

    expect(started.verified).toBe(true);
  });

  it('the same function under a different secret is refused', async () => {
    const desk = world.substrat;
    const widget = await host.getScope(desk.widget.principal, desk.tenant, desk.scope);
    const email = 'staff@substrat.net';

    // The failure that matters is not a mangled signature — it is a correctly-computed
    // one from a deployment holding the wrong secret, which is what a half-finished
    // rotation looks like. It must be refused as flatly as a forgery.
    await expect(
      widget.invoke('ticket0/widget-start', {
        origin: desk.origin,
        identity: {
          externalId: email,
          email,
          signature: await signVisitorIdentity('not-this-desks-secret', email),
        },
      }),
    ).rejects.toThrow(/signature does not verify/i);
  });
});
