/**
 * An `/api/auth/*` path this instance does not serve answers a problem document (#113): accounts
 * live at the issuer, so sign-up and password routes have no server here. The `issuer` member
 * rides beside the standard ones so a caller can follow it.
 */
import { describe, expect, it } from 'vitest';
import { PROBLEM_CONTENT_TYPE } from '@substrat-run/contracts';
import { oidcRpAuthProvider } from '../src/oidc-rp-provider.js';

describe('an unserved /api/auth path', () => {
  it('answers 404 as application/problem+json, error beside detail, naming the issuer', async () => {
    const provider = oidcRpAuthProvider({
      issuer: 'https://issuer-unserved.test',
      clientId: 'c',
      clientSecret: 's',
      sessionSecret: 'session-secret-000000000000000000000001',
    });
    const res = await provider.handle(new Request('https://app.example.com/api/auth/sign-up/email'));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(await res.json()).toMatchObject({
      status: 404,
      detail: 'this instance authenticates at its OIDC issuer',
      error: 'this instance authenticates at its OIDC issuer',
      instance: '/api/auth/sign-up/email',
      issuer: 'https://issuer-unserved.test',
    });
  });
});
