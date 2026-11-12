import { describe, expect, it } from 'vitest';
import { EXPORTED_EVENTS_HEADER, PLATFORM_REQUEST_HEADER } from '@substrat-run/contracts/wire-headers';
import { scopeId } from '@substrat-run/contracts';
import { kickFlags } from '../src/kick-flags.js';

const scope = scopeId.parse('01JZ0000000000000000000002');

/**
 * #1705 PR 2 — the kick's two response flags, as one call a worker spreads into `getScope`'s
 * options. Each callback raises its own header and nothing else; the router reads exactly these
 * names, from contracts' wire headers.
 */
describe('kickFlags (#1705 PR 2)', () => {
  it('raises each flag under its own header, only when its callback fires', () => {
    const set: [string, string][] = [];
    const flags = kickFlags((name, value) => set.push([name, value]));
    expect(set).toEqual([]);
    // The intent flag names the scope the intents went into, for the router to drain there.
    flags.onPlatformRequests?.(2, scope);
    expect(set).toEqual([[PLATFORM_REQUEST_HEADER, scope]]);
    flags.onExportedEvents?.(1);
    expect(set).toEqual([
      [PLATFORM_REQUEST_HEADER, scope],
      [EXPORTED_EVENTS_HEADER, '1'],
    ]);
    expect([PLATFORM_REQUEST_HEADER, EXPORTED_EVENTS_HEADER]).toEqual([
      'x-substrat-platform-request',
      'x-substrat-exported-events',
    ]);
  });
});
