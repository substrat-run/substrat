import * as client from '@substrat-run/control-plane-client';
import { describe, expect, it } from 'vitest';
import * as browser from '../src/browser.js';
import * as root from '../src/index.js';
import { DEV_ACTOR_HEADER, SERVICE_TOKEN_HEADER, TENANT_HEADER } from '../src/auth.js';

/**
 * The client moved into its own Apache-2.0 package (#971); this package re-exports it so
 * every existing import — the console's, a vertical's, `errors.ts`'s — kept its path. The
 * property worth holding is IDENTITY, not just presence: `instanceof ControlPlaneError`
 * across the two copies would be false if either entry carried a second class.
 */
describe('the client package, re-exported', () => {
  const names = Object.keys(client);

  it('has a surface to re-export (the positive twin of the loops below)', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        'ControlPlaneClient',
        'ControlPlaneError',
        'ControlPlaneTransport',
        'identityTenant',
        'identityTenantsResponse',
        'DEV_ACTOR_HEADER',
        'SERVICE_TOKEN_HEADER',
        'TENANT_HEADER',
      ]),
    );
  });

  it.each(names)('the root entry exposes %s as the same binding', (name) => {
    expect((root as Record<string, unknown>)[name]).toBe((client as Record<string, unknown>)[name]);
  });

  it.each(names)('the browser entry exposes %s as the same binding', (name) => {
    expect((browser as Record<string, unknown>)[name]).toBe((client as Record<string, unknown>)[name]);
  });

  it('reads the header names the server checks from the same definition', () => {
    expect(DEV_ACTOR_HEADER).toBe(client.DEV_ACTOR_HEADER);
    expect(SERVICE_TOKEN_HEADER).toBe(client.SERVICE_TOKEN_HEADER);
    expect(TENANT_HEADER).toBe(client.TENANT_HEADER);
    expect(root.DEV_ACTOR_HEADER).toBe('x-platform-actor');
  });

  it('keeps the server out of the browser entry (a name only the server has)', () => {
    expect('createControlPlaneApi' in root).toBe(true);
    expect('createControlPlaneApi' in browser).toBe(false);
  });
});
