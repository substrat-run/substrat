import { describe, expect, it } from 'vitest';
import type { SystemGrantsStatusEntry } from '@substrat-run/contracts';
import { ApiError } from '../src/lib/api';
import {
  errorMessage,
  performSwitch,
  schedulesCardState,
  scheduleBadgeStatus,
  submitSwitch,
  validReason,
} from '../src/lib/schedules';

/**
 * The Schedules card (#1675) maps one status read into four card states, and the
 * switch buttons into one guarded submit. The console has no component-test harness
 * (`apps/console/test/` is pure `lib/*.ts` unit tests throughout), so these test the
 * pure mapping and guard functions the component calls rather than rendered output.
 */

const onEntry = {
  moduleId: '@substrat-run/engine-absence',
  schedules: 'on',
  switchedOff: null,
} as unknown as SystemGrantsStatusEntry;

const offEntry = {
  moduleId: '@substrat-run/engine-workorder',
  schedules: 'off',
  switchedOff: {
    actor: '01J00000000000000000000000',
    reason: 'incident #42',
    at: '2026-09-01T12:00:00.000Z',
  },
} as unknown as SystemGrantsStatusEntry;

const ungrantedEntry = {
  moduleId: '@substrat-run/engine-invoicing',
  schedules: 'ungranted',
  switchedOff: null,
} as unknown as SystemGrantsStatusEntry;

describe('schedulesCardState', () => {
  it('no entries yet and no error: loading', () => {
    expect(schedulesCardState(null, null)).toEqual({ kind: 'loading' });
  });

  it('entries landed: ready, carrying on/off/ungranted rows as-is', () => {
    const entries = [onEntry, offEntry, ungrantedEntry];
    expect(schedulesCardState(entries, null)).toEqual({ kind: 'ready', entries });
  });

  it('an off row keeps its switchedOff details in the ready state', () => {
    const state = schedulesCardState([offEntry], null);
    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') {
      expect(state.entries[0]!.switchedOff).toEqual({
        actor: '01J00000000000000000000000',
        reason: 'incident #42',
        at: '2026-09-01T12:00:00.000Z',
      });
    }
  });

  it('a 501 (the deployment predates the switch/status route) is its own state, never an error', () => {
    expect(schedulesCardState(null, new ApiError(501, 'redeploy the vertical'))).toEqual({ kind: 'predates' });
  });

  it('a 503 (no delegation configured, #1703) is an error, never read as on', () => {
    expect(schedulesCardState(null, new ApiError(503, 'no delegation configured for hosted scope'))).toEqual({
      kind: 'error',
      message: 'no delegation configured for hosted scope',
    });
  });

  it('any other failure is an error too', () => {
    expect(schedulesCardState(null, new Error('network down'))).toEqual({ kind: 'error', message: 'network down' });
  });
});

describe('scheduleBadgeStatus', () => {
  it('maps on/off/ungranted to their badge tones', () => {
    expect(scheduleBadgeStatus('on')).toBe('success');
    expect(scheduleBadgeStatus('off')).toBe('danger');
    expect(scheduleBadgeStatus('ungranted')).toBe('neutral');
  });
});

describe('validReason', () => {
  it('rejects empty and whitespace-only reasons', () => {
    expect(validReason('')).toBe(false);
    expect(validReason('   ')).toBe(false);
  });

  it('accepts a real reason and its twin: too long is refused', () => {
    expect(validReason('incident #42, restoring after the vendor outage')).toBe(true);
    expect(validReason('x'.repeat(501))).toBe(false);
    expect(validReason('x'.repeat(500))).toBe(true);
  });
});

describe('submitSwitch', () => {
  it('a second submit while the first is in flight sends nothing — the flag is a ref, not state', async () => {
    const flag = { current: false };
    let calls = 0;
    let release!: (v: { changed: boolean }) => void;
    const run = () => {
      calls += 1;
      return new Promise<{ changed: boolean }>((r) => (release = r));
    };
    const first = submitSwitch(flag, run);
    const second = submitSwitch(flag, run);
    expect(await second).toBeNull();
    release({ changed: true });
    expect(await first).toEqual({ changed: true });
    expect(calls).toBe(1);
  });

  it('its twin: once the first settles, the next submit runs', async () => {
    const flag = { current: false };
    let calls = 0;
    const run = async () => {
      calls += 1;
      return { changed: true };
    };
    expect(await submitSwitch(flag, run)).toEqual({ changed: true });
    expect(await submitSwitch(flag, run)).toEqual({ changed: true });
    expect(calls).toBe(2);
  });

  it('a refused switch releases the flag and still rejects, rather than swallowing the error', async () => {
    const flag = { current: false };
    await expect(submitSwitch(flag, () => Promise.reject(new ApiError(409, 'conflict')))).rejects.toThrow(
      'conflict',
    );
    expect(flag.current).toBe(false);
  });
});

describe('errorMessage', () => {
  it('reads an Error message, and falls back to String() for anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain string')).toBe('plain string');
  });
});

/**
 * The write and the re-read are two separate failures (Copilot review on #1707,
 * thread 4073371122): the naive single `try/catch` this replaces caught both steps
 * together, so a switch that landed but whose follow-up read failed ALSO reported
 * "Refused" — with the card still showing the stale, now-wrong position. An operator
 * reading that would retry a switch that had already happened.
 */
describe('performSwitch', () => {
  it('switch ok + refresh fails: unconfirmed, never refused, carries the read error', async () => {
    const refresh = () => Promise.reject(new Error('status read timed out'));
    const attempt = await performSwitch(async () => ({ changed: true }), refresh);
    expect(attempt.kind).toBe('unconfirmed');
    if (attempt.kind === 'unconfirmed') {
      expect(attempt.result).toEqual({ changed: true }); // the write DID land
      expect(errorMessage(attempt.error)).toBe('status read timed out');
    }
  });

  it('switch fails: refused, and the refresh is never attempted', async () => {
    let refreshCalls = 0;
    const refresh = async () => {
      refreshCalls += 1;
      return [];
    };
    const attempt = await performSwitch(() => Promise.reject(new ApiError(409, 'conflict')), refresh);
    expect(attempt).toEqual({ kind: 'refused', error: expect.any(ApiError) });
    if (attempt.kind === 'refused') expect(errorMessage(attempt.error)).toBe('conflict');
    expect(refreshCalls).toBe(0);
  });

  it('its twin: both steps land, and applied carries the fresh read', async () => {
    const attempt = await performSwitch(
      async () => ({ changed: true }),
      async () => ['fresh'],
    );
    expect(attempt).toEqual({ kind: 'applied', result: { changed: true }, entries: ['fresh'] });
  });
});
