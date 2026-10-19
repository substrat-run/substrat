/**
 * The run key is reserved to a system principal by this engine's own manifest.
 *
 * `lint:permissions` refuses a role or entity grant shape that carries a key some manifest
 * declares `holder: 'system'`, and reads nothing else to decide it. So the guarantee that no
 * person can write the assistant's side of a thread is exactly this declaration: dropped, every
 * vertical composing the engine could hand `assistant:run` to a role and stay green.
 */
import { describe, expect, it } from 'vitest';
import { assistantManifest } from '../src/index.js';

describe('assistant: who may hold each key', () => {
  it('declares assistant:run for a system principal only, and leaves use and audit to anyone', () => {
    expect(Object.fromEntries(assistantManifest.permissions.map((p) => [p.key, p.holder ?? null]))).toEqual({
      'assistant:use': null,
      'assistant:audit': null,
      'assistant:run': 'system',
    });
  });
});
