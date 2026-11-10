import { afterEach, describe, expect, it, vi } from 'vitest';
import { log, noteVersion } from '../src/log.js';

describe('the issuer log line', () => {
  afterEach(() => {
    noteVersion({});
    vi.restoreAllMocks();
  });

  it('names the served version, which no detail key can overwrite, and keeps an error readable', () => {
    const write = vi.spyOn(console, 'error').mockImplementation(() => {});
    noteVersion({ SUBSTRAT_VERSION_ID: '01JTESTVRSN0000000000000A0' });
    log.error('env admin seed failed', { error: new Error('boom'), version: 'forged', app: 'forged' });
    const line = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(line).toMatchObject({ message: 'env admin seed failed', app: 'auth-server', version: '01JTESTVRSN0000000000000A0' });
    expect(line.error).toMatchObject({ name: 'Error', message: 'boom' });
  });

  it('writes a null version where nothing injected one', () => {
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});
    noteVersion({ SUBSTRAT_VERSION_ID: '' });
    log.info('seeded the admin console client');
    expect(JSON.parse(String(write.mock.calls[0]?.[0])).version).toBeNull();
  });
});
