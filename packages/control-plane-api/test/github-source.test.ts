import { describe, expect, it, vi } from 'vitest';
import { installationToken } from '../src/github-app.js';

describe('source repository GitHub credentials', () => {
  it.each([false, true])('restricts an installation token to one repository and the requested write capability: %s', async (write) => {
    const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const key = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...key))}\n-----END PRIVATE KEY-----`;
    const fetchImpl = vi.fn(async () => Response.json({ token: 'repository-token' }));
    const token = await installationToken({ appId: '123', appSlug: 'fixture', privateKeyPem: pem, fetchImpl }, '456', { name: 'demo', write });
    expect(token).toBe('repository-token');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/app/installations/456/access_tokens');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ repositories: ['demo'], permissions: { contents: write ? 'write' : 'read', metadata: 'read' } });
  });
});
