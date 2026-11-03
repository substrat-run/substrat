/**
 * The studio scope (src/studio.ts) over a REAL SqliteScopeHost, for suites that
 * drive the studio's engines end to end. Only the Cloudflare adapter CLASS is
 * replaced: `provisionScopeLocal` and `assignScopeRole` are carried out through
 * the sqlite host's HostAdmin (the same recipe engine-test-kit uses), so the
 * modules, their migrations, the permission checker and the reserved-key doors
 * are all real.
 *
 * Use: `vi.mock('@substrat-run/adapter-cloudflare', () => import('./studio-shim.js'))`,
 * then `startStudio()` in `beforeEach` and `stopStudio()` in `afterEach`, and
 * `vi.resetModules()` before importing the module under test — studio.ts
 * memoizes its provisioning per module instance.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformActorId, type PrincipalId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';

interface Studio {
	dir: string;
	host: SqliteScopeHost;
	registered: Set<string>;
	tenantId: TenantId | null;
	/** The owner's role, captured at provision, so a test can seat another writer. */
	ownerRoleKey: string;
}

// On globalThis, not in a module variable: `vi.resetModules()` gives the mocked
// adapter a fresh instance of this file, and it must still see the test's studio.
const SLOT = Symbol.for('substrat.builder.studio-shim');
const slot = globalThis as { [SLOT]?: Studio | null };

function studio(): Studio {
	const current = slot[SLOT];
	if (!current) throw new Error('studio shim not started');
	return current;
}

export function startStudio(): Studio {
	const dir = mkdtempSync(join(tmpdir(), 'builder-studio-'));
	const current: Studio = { dir, host: new SqliteScopeHost({ dir }), registered: new Set(), tenantId: null, ownerRoleKey: '' };
	slot[SLOT] = current;
	return current;
}

export function stopStudio(): void {
	const current = slot[SLOT];
	if (current) rmSync(current.dir, { recursive: true, force: true });
	slot[SLOT] = null;
}

const staff = () => platformActorId.parse(ulid());

export class CloudflareScopeHost {
	// studio.ts constructs a fresh host per call and re-registers the modules each
	// time; the sqlite host refuses duplicates, so the shim dedupes.
	registerModule(m: { manifest: { id: string } }): void {
		const s = studio();
		if (s.registered.has(m.manifest.id)) return;
		s.registered.add(m.manifest.id);
		s.host.registerModule(m as never);
	}

	async provisionScopeLocal(input: {
		tenantId: TenantId;
		scopeId: ScopeId;
		owner: PrincipalId;
		roles: unknown[];
		ownerRoleKey: string;
	}): Promise<void> {
		const s = studio();
		s.ownerRoleKey = input.ownerRoleKey;
		s.tenantId = input.tenantId;
		await s.host.admin.createTenant(staff(), { id: input.tenantId, slug: 'studio', name: 'Builder studio' });
		// The sqlite host enforces entitlements at invoke (unlike the un-projected
		// CF scope, which trusts upstream) — grant each module's own key.
		for (const key of ['metering', 'assistant']) await s.host.admin.grantEntitlement(staff(), input.tenantId, key);
		await s.host.provisionScope(staff(), { tenantId: input.tenantId, scopeId: input.scopeId, jurisdiction: 'global' });
		await s.host.admin.activateScope(staff(), input.tenantId, input.scopeId);
		for (const role of input.roles) await s.host.admin.defineRole(staff(), input.tenantId, role as never);
		await this.assignScopeRole(input.scopeId, input.owner, input.ownerRoleKey);
	}

	async assignScopeRole(scopeId: ScopeId, principal: PrincipalId, roleKey: string): Promise<void> {
		const s = studio();
		await s.host.admin.assignRole(staff(), {
			principalId: principal,
			roleKey,
			node: { tenantId: s.tenantId!, scopeId },
		});
	}

	getScope(p: PrincipalId, t: TenantId, scope: ScopeId) {
		return studio().host.getScope(p, t, scope);
	}
}
