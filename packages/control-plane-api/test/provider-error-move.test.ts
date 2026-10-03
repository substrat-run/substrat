/**
 * #1978: the delivery-failure classifier is moving here from the kernel. For one release
 * the kernel still exports it, and an import from either package must be the ONE binding.
 */
import { describe, expect, it } from 'vitest';
import * as kernel from '@substrat-run/kernel';
import * as api from '../src/index.js';
import * as providerError from '../src/provider-error.js';

const NAMES = ['isTerminalDispatchFailure', 'isTerminalProviderError', 'providerErrorStatus', 'RETRYABLE_CLIENT_STATUSES'];

describe('provider-error, moving here from the kernel (#1978)', () => {
  it('forwards exactly the moved names', () => {
    expect(Object.keys(providerError).sort()).toEqual([...NAMES].sort());
  });

  it("each one is the kernel's binding, from the module and from the package index", () => {
    for (const name of NAMES) {
      const kernelBinding = (kernel as Record<string, unknown>)[name];
      expect(kernelBinding, name).toBeDefined();
      expect((providerError as Record<string, unknown>)[name], name).toBe(kernelBinding);
      expect((api as Record<string, unknown>)[name], name).toBe(kernelBinding);
    }
  });
});
