/**
 * #3161: the vocabulary of a delegation on the `peer` channel. The default is the property that
 * matters most: a grant delivered before `peer` existed names no channel, and must keep meaning
 * `mcp` alone, never gain the wider channel by being re-read.
 */
import { describe, expect, it } from 'vitest';
import { channelsOf, delegationGrant } from '../src/delegations.js';
import { moduleManifest } from '../src/manifest.js';
import { peerCallRequest } from '../src/peer-transport.js';

const actor = '01JA0000000000000000000000';

describe('delegation channels', () => {
  it('a grant naming no channel admits mcp alone', () => {
    const grant = delegationGrant.parse({ actor, permissions: ['notes:read'] });
    expect(channelsOf(grant)).toEqual(['mcp']);
    expect(channelsOf(delegationGrant.parse({ ...grant, channels: ['peer'] }))).toEqual(['peer']);
  });

  it('refuses a channel named twice, and one that does not exist', () => {
    expect(delegationGrant.safeParse({ actor, permissions: ['notes:read'], channels: ['peer', 'peer'] }).success).toBe(false);
    expect(delegationGrant.safeParse({ actor, permissions: ['notes:read'], channels: ['email'] }).success).toBe(false);
  });
});

describe('peer call on behalf of a person', () => {
  it('onBehalf carries a token and nothing else: a principal named beside it is refused', () => {
    const call = { vertical: 'notes', operation: 'notes/list' };
    expect(peerCallRequest.safeParse({ ...call, onBehalf: { token: 'eyJ.x.y' } }).success).toBe(true);
    expect(peerCallRequest.safeParse({ ...call, onBehalf: { token: 'eyJ.x.y', sub: 'ada' } }).success).toBe(false);
  });
});

describe('manifest delegations', () => {
  const manifest = (delegations: unknown) =>
    moduleManifest.safeParse({
      id: '@acme/notes',
      version: '0.1.0',
      kernelContract: '^0.1.0',
      permissions: [{ key: 'notes:read', description: 'read' }],
      events: { emits: [], consumes: [] },
      migrations: { journalDir: 'm', compatibleFrom: '0.0.0' },
      attachmentTargets: [],
      entitlementKey: 'x',
      delegations,
    });

  it('refuses an actor declared twice, a key listed twice and a channel listed twice', () => {
    expect(manifest([{ actor: 'todo', permissions: ['notes:read'], channels: ['peer'] }]).success).toBe(true);
    expect(manifest([{ actor: 'todo', permissions: ['notes:read'] }, { actor: 'todo', permissions: ['notes:read'] }]).success).toBe(false);
    expect(manifest([{ actor: 'todo', permissions: ['notes:read', 'notes:read'] }]).success).toBe(false);
    expect(manifest([{ actor: 'todo', permissions: ['notes:read'], channels: ['peer', 'peer'] }]).success).toBe(false);
  });
});
