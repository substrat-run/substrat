import { afterEach, describe, expect, it, vi } from 'vitest';
import { teamApi } from '../src/lib/api';

/**
 * The Team view's calls go through `teamApi(teamId)` (#2170): every roster read and write
 * names its team in its own URL, so a second tab on another team cannot decide which
 * team's members this tab lists, invites into or removes from. The worker side of these
 * same paths is `test/members-team-routes.test.ts`.
 */
describe('teamApi: the members & invites calls', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('names the team in every path, with the verbs and bodies the worker serves, and sends the session', async () => {
    const seen: { url: string; method: string; body: unknown; credentials?: RequestCredentials }[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        credentials: init?.credentials,
      });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const client = teamApi('T 1');
    await client.listMembers({});
    await client.listMembers({ cursor: 'c 1' });
    await client.inviteMember({ email: 'rae@acme.test', roleKey: 'viewer' });
    await client.resendInvite({ invitationId: 'I1' });
    await client.inviteLink({ invitationId: 'I1' });
    await client.revokeInvite({ invitationId: 'I1' });
    await client.removeMember({ memberId: 'M1' });
    await client.leaveTeam();

    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /api/teams/T%201/members',
      'GET /api/teams/T%201/members?cursor=c+1',
      'POST /api/teams/T%201/members/invites',
      'POST /api/teams/T%201/members/invites/I1/resend',
      'POST /api/teams/T%201/members/invites/I1/link',
      'DELETE /api/teams/T%201/members/invites/I1',
      'DELETE /api/teams/T%201/members/M1',
      'POST /api/teams/T%201/leave',
    ]);
    expect(seen[2]!.body).toEqual({ email: 'rae@acme.test', roleKey: 'viewer' });
    expect(seen.every((s) => s.credentials === 'include')).toBe(true);
  });

  it('a refusal surfaces as the problem body’s message, not a silent success', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'permission denied: dashboard:manage-members' }), {
          status: 403,
          headers: { 'content-type': 'application/problem+json' },
        }),
    ) as unknown as typeof fetch;
    await expect(teamApi('T1').removeMember({ memberId: 'M1' })).rejects.toThrow(/manage-members/);
  });
});
