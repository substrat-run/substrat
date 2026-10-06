import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { platformActorId, principalId, scopeId, tenantId, type AdminLogEntry } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { withAuditedOutcomes } from '@substrat-run/control-plane-api';
import { AuditedOutcome } from '../src/views/AdminLog';

/**
 * #2064: intent → unknown → applied, as the console shows it. The rows are resolved by the
 * admin-log API's own producer (`withAuditedOutcomes`) and sent through JSON as the wire does.
 * The latest outcome wins: the intent reads `applied`, the settle's `unknown` reads as
 * superseded, and every raw row is still there.
 */
describe('the admin log reads an audited change by its latest outcome', () => {
  const actor = platformActorId.parse(ulid());
  const operationId = ulid();
  const at = (s: number) => new Date(Date.UTC(2026, 9, 6, 12, 0, s)).toISOString();
  const row = (phase: string, s: number, extra: object = {}): AdminLogEntry => ({
    id: ulid(),
    actor,
    action: 'transferOwner',
    tenantId: tenantId.parse(ulid()),
    scopeId: scopeId.parse(ulid()),
    vertical: null,
    before: null,
    after: { phase, operationId, from: principalId.parse(ulid()), to: principalId.parse(ulid()), ...extra },
    causedBy: null,
    at: at(s) as AdminLogEntry['at'],
  });

  const render = async (rows: AdminLogEntry[]) => {
    const scoped = rows.map((r) => ({ ...r, tenantId: rows[0]!.tenantId, scopeId: rows[0]!.scopeId }));
    // The batched read answers this operation's rows, as `HostAdmin.auditedOperations` does.
    const auditedOperations = async () =>
      scoped.map((r) => ({ id: r.id, action: r.action, tenantId: r.tenantId, scopeId: r.scopeId, operationId, phase: (r.after as { phase: string }).phase }));
    const resolved = await withAuditedOutcomes({ auditedOperations }, actor, scoped);
    const wire = JSON.parse(JSON.stringify(resolved)) as AdminLogEntry[];
    return wire.map((e) => renderToString(createElement(AuditedOutcome, { entry: e })).replace(/<!-- -->/g, ''));
  };

  it('settled unknown, then the real outcome: the intent reads applied, the unknown is superseded', async () => {
    const [intent, unknown, applied] = await render([
      row('intent', 0),
      row('unknown', 1, { error: 'no outcome was recorded' }),
      row('applied', 2, { outcome: 'transferred', fromRevoked: true }),
    ]);
    expect(intent).toContain('→ applied');
    expect(unknown).toContain('<s>unknown</s> · superseded by applied');
    expect(applied).toContain('applied');
    expect(applied).not.toContain('superseded');
  });

  it('twin: before the real outcome lands, the intent reads unknown and nothing is superseded', async () => {
    const [intent, unknown] = await render([row('intent', 0), row('unknown', 1, { error: 'no outcome was recorded' })]);
    expect(intent).toContain('→ unknown');
    expect(unknown).not.toContain('superseded');
  });

  it('a row of any other action shows nothing extra', () => {
    const entry = { ...row('intent', 0), action: 'createTenant' } as AdminLogEntry;
    expect(renderToString(createElement(AuditedOutcome, { entry }))).toBe('');
  });
});
