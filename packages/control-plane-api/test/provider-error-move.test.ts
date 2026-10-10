/**
 * #1978: the delivery-failure classifier moved here from the kernel (#1998), beside the drain
 * that is its only reader. The kernel no longer exports it.
 */
import { describe, expect, it } from 'vitest';
import * as kernel from '@substrat-run/kernel';
import * as api from '../src/index.js';

const MOVED = ['isTerminalDispatchFailure', 'isTerminalProviderError', 'providerErrorStatus', 'RETRYABLE_CLIENT_STATUSES'];

describe('provider-error, moved here from the kernel (#1978)', () => {
  it.each(MOVED)('exports %s, and the kernel does not', (name) => {
    expect((api as Record<string, unknown>)[name], name).toBeDefined();
    expect((kernel as Record<string, unknown>)[name], name).toBeUndefined();
  });
});
