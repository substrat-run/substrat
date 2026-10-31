import { describe, expect, it } from 'vitest';
import { assertDeclaredScopeStores, type StoreDriverRegistration } from '@substrat-run/contracts';
import { SCOPE_STORES } from '../src/manifest.js';

// The check `substrat push` and the control plane make on a scope-store declaration.
describe('the deploy check on this vertical’s scope store', () => {
  it('refuses the graph store while no driver is registered', () => {
    expect(() => assertDeclaredScopeStores({ scopeStores: SCOPE_STORES })).toThrow(
      "deploy refused: scope store 'GRAPH' declares driver 'graph', which is not registered.",
    );
  });

  it('admits it against a registry that holds the graph driver', () => {
    const drivers: StoreDriverRegistration[] = [{ driver: 'graph', isolationBasis: { kind: 'writtenInRepo' } }];
    expect(() => assertDeclaredScopeStores({ scopeStores: SCOPE_STORES, drivers })).not.toThrow();
  });
});
