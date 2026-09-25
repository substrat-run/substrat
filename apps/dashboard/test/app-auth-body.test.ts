import { describe, expect, it } from 'vitest';
import { appAuthChoiceBody } from '../src/app-auth-body.js';

/** The API's Identity choice: an external issuer is https, or it cannot be saved at all. */
const external = (issuer: string) => appAuthChoiceBody.safeParse({ source: 'external', issuer, clientId: 'cid', clientSecret: 'cs' });

describe('an external issuer in the Identity choice', () => {
  it('must be https: a plaintext issuer is refused at save time', () => {
    expect(external('http://auth.example.com').success).toBe(false);
  });

  it('accepts https, and a loopback dev issuer (positive twins)', () => {
    expect(external('https://auth.example.com').success).toBe(true);
    expect(external('http://localhost:8879').success).toBe(true);
  });
});
