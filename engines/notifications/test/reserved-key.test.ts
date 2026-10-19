/**
 * The digest schedule's key is reserved to a system principal by this engine's own manifest.
 *
 * `lint:permissions` refuses a role or entity grant shape that carries a key some manifest
 * declares `holder: 'system'`, and reads nothing else to decide it. So the guarantee that no
 * person can send a scope's due digests on demand is exactly this declaration: dropped, every
 * vertical composing the engine could hand `notifications:send-digests` to a role and stay green.
 */
import { describe, expect, it } from 'vitest';
import { notificationsManifest } from '../src/index.js';

describe('notifications: who may hold each key', () => {
  it('declares send-digests for a system principal only, and leaves self and read to anyone', () => {
    expect(Object.fromEntries(notificationsManifest.permissions.map((p) => [p.key, p.holder ?? null]))).toEqual({
      'notifications:self': null,
      'notifications:read': null,
      'notifications:send-digests': 'system',
    });
  });

  it('the schedule that holds it is the engine’s own system principal', () => {
    expect((notificationsManifest.schedules ?? []).flatMap((s) => s.permissions)).toEqual(['notifications:send-digests']);
  });
});
