import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ENGINE_ENTITLEMENT_KEYS,
  entitlementNamespaceRefusal,
  grantableEntitlements,
} from '../src/entitlement-namespace.js';

describe('entitlement key namespace (#2388)', () => {
  it('accepts a vertical own key (workspace prefix stripped) and an engine key', () => {
    expect(entitlementNamespaceRefusal('t-abc/helpdesk', ['helpdesk', 'protocol'])).toBeUndefined();
  });

  it("refuses another vertical's key, naming the key and the vertical's own namespace", () => {
    expect(entitlementNamespaceRefusal('helpdesk', ['helpdesk', 'crm'])).toMatch(
      /^entitlement 'crm' is not declarable by 'helpdesk'/,
    );
  });

  it('lets a manager declare a plan SKU, but not another vertical slug', () => {
    expect(entitlementNamespaceRefusal('console', ['flows'], ['console', 'crm'])).toBeUndefined();
    expect(entitlementNamespaceRefusal('console', ['crm'], ['console', 'crm'])).toMatch(/^entitlement 'crm' /);
  });

  it('refuses a platform key, even for a manager or a vertical whose slug spells it', () => {
    expect(entitlementNamespaceRefusal('acme/builder', ['builder'])).toMatch(/^entitlement 'builder' /);
    expect(entitlementNamespaceRefusal('console', ['dashboard'], [])).toMatch(/^entitlement 'dashboard' /);
  });

  it('keeps only declarable keys of a row pushed before the rule', () => {
    expect(grantableEntitlements('helpdesk', ['crm', 'helpdesk', 'builder'])).toEqual(['helpdesk']);
  });

  it('lists every engine key the engines declare', () => {
    const enginesDir = fileURLToPath(new URL('../../../engines/', import.meta.url));
    const declared = readdirSync(enginesDir)
      .filter((name) => existsSync(`${enginesDir}${name}/src/index.ts`))
      .map((name) => {
        const keys = [...readFileSync(`${enginesDir}${name}/src/index.ts`, 'utf8').matchAll(/entitlementKey:\s*'([^']+)'/g)];
        expect(keys, `engines/${name} declares exactly one entitlementKey literal`).toHaveLength(1);
        return keys[0]![1];
      });
    expect(declared.sort()).toEqual([...ENGINE_ENTITLEMENT_KEYS].sort());
  });
});
