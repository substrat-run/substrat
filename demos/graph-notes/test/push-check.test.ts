import { describe, expect, it } from 'vitest';
import { assertDeclaredScopeStores } from '@substrat-run/contracts';
import { SCOPE_STORES } from '../src/manifest.js';

// The check `substrat push` and the control plane make on a scope-store declaration.
describe('the deploy check on this vertical’s scope store', () => {
  it('admits the graph store: the platform registers the graph driver', () => {
    expect(() => assertDeclaredScopeStores({ scopeStores: SCOPE_STORES })).not.toThrow();
  });

  it('refuses it against a registry that does not hold the graph driver', () => {
    expect(() => assertDeclaredScopeStores({ scopeStores: SCOPE_STORES, drivers: [] })).toThrow(
      "deploy refused: scope store 'GRAPH' declares driver 'graph', which is not registered.",
    );
  });
});
