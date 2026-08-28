import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EntityRef, Page } from '@substrat-run/contracts';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  PROTOCOL_PERM as PERM,
  defineTemplate,
  getProtocol,
  instantiateProtocol,
  listProtocolsForEntity,
  listTemplates,
  protocolModule,
  signProtocol,
  type ProtocolInstanceRow,
  type ProtocolSummary,
  type ProtocolTemplateRow,
} from '../src/index.js';
import { columnsOf } from '../src/seam.js';
import { protocolInstanceRow } from '../src/entities.js';
import {
  protocolResponseRow,
  protocolSignatureRequestRow,
  protocolSignatureRow,
  protocolTemplateRow,
} from '../src/schemas.js';

/**
 * The seam, under drift (#771) — engine-protocol's copy of workorder's suite.
 *
 * Every test here answers one question: when the stored row stops matching the
 * shape this engine PUBLISHES, does the caller get a throw or wrong data? Before
 * this, the answer was wrong data — the return values crossed the seam typed by a
 * TypeScript assertion that is not there at runtime, and `SELECT *` pinned the
 * published shape to whatever the physical table happened to hold.
 *
 * It matters more here than in most engines: a signature attests to a hash over
 * these rows, and a row that quietly changed shape is a row whose hash no longer
 * says what the signatory was shown.
 *
 * The drift is simulated the only honest way available: by moving the table under
 * a running engine, which is what a vertical compiled against 0.3 and running
 * against 0.4 is actually looking at.
 */

const ORDER: EntityRef = { entityType: 'workorder', entityId: '01JWORKORDER000000000000000' };

const CONTENT = {
  sections: [
    {
      title: 'Broms',
      items: [
        { key: 'front-brake', label: 'Frambroms', type: 'check' as const },
        { key: 'pad-mm', label: 'Belägg', type: 'value' as const, unit: 'mm' },
      ],
    },
  ],
};

describe('engine-protocol — the seam is parsed, not asserted', () => {
  let h: EngineHarness;
  let staff: Awaited<ReturnType<EngineHarness['as']>>;

  beforeEach(async () => {
    h = await engineHarness({
      modules: [protocolModule],
      // The vertical's edge: the engine has never heard of a work order.
      entityRelations: [{ entityType: 'protocol', parentType: 'workorder' }],
    });
    staff = await h.as([PERM.create, PERM.fill, PERM.sign, PERM.read]);
  });
  afterEach(async () => {
    await h.close();
  });

  const template = (key = 'self-inspection') =>
    h.run((ctx) => defineTemplate(ctx, { key, title: 'Self-inspection', content: CONTENT }));

  const instantiate = (templateKey = 'self-inspection') =>
    h.run((ctx) => instantiateProtocol(ctx, { templateKey, entity: ORDER }));

  /** Move the table under the engine, the way a version bump would. */
  const drift = (sql: string) => h.run((ctx) => void ctx.sql.exec(sql));

  // -- the SELECT list is derived from the row schema ---------------------------

  it('names the columns a row schema describes, in its order', () => {
    expect(columnsOf(protocolTemplateRow)).toBe(
      'id, key, version, title, content_json, created_at',
    );
    expect(columnsOf(protocolInstanceRow)).toBe(
      'id, template_key, template_version, entity_type, entity_id, status, created_by, ' +
        'created_at, voided_by, voided_reason, voided_at, content_ref_type, content_ref_id, ' +
        'bound_hash, document_attachment_id, frozen_hash, frozen_at',
    );
    expect(columnsOf(protocolResponseRow)).toBe(
      'id, instance_id, item_key, value_json, note, responded_by, responded_at',
    );
    expect(columnsOf(protocolSignatureRow)).toBe(
      'id, instance_id, signed_by, kind, method, content_hash, evidence_ref, signed_at, ' +
        'request_id, signatory_kind, signatory_label',
    );
    expect(columnsOf(protocolSignatureRequestRow)).toBe(
      'id, instance_id, party_label, party_kind, party_ref, signature_kind, method, ' +
        'auth_level, contact_key_id, contact_ciphertext, status, content_hash, external_ref, ' +
        'resolved_note, requested_by, requested_at, resolved_at',
    );
  });

  it('a column that vanished fails AT THE READ, naming itself', async () => {
    await template();
    const inst = await instantiate();
    await staff.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'front-brake', value: true });
    // The published shape still says `note`; the table no longer does.
    await drift('ALTER TABLE protocol_responses DROP COLUMN note');

    // `SELECT *` would have returned a row quietly missing the field. Naming the
    // columns makes the read itself refuse, and say which column it wanted.
    await expect(h.run((ctx) => getProtocol(ctx, inst.id))).rejects.toThrow(/no such column: note/);
  });

  it('a column added upstream never crosses the seam', async () => {
    await drift('ALTER TABLE protocol_templates ADD COLUMN internal_note TEXT');
    const defined = await template();
    await drift(`UPDATE protocol_templates SET internal_note = 'never published'`);

    const page = await h.run((ctx) => listTemplates(ctx, {}));
    const paged = await staff.invoke<Page<ProtocolTemplateRow>>('protocol/list-templates');
    for (const row of [defined, ...page.entries, ...paged.entries]) {
      expect(Object.keys(row)).toEqual(['id', 'key', 'version', 'title', 'content_json', 'created_at']);
      expect(row).not.toHaveProperty('internal_note');
    }
  });

  // -- a drifted row throws instead of surfacing as wrong data ------------------

  it('an instance whose row drifted throws at the seam, on every path out', async () => {
    await template();
    const inst = await instantiate();
    // `template_version` is INTEGER in the table and `z.number()` in the published
    // shape; SQLite keeps a non-numeric literal as text, which is exactly the
    // retype an additive-only rule exists to forbid and nothing at runtime
    // enforced. (`status` cannot drift this way — its CHECK constraint is the
    // migration's own guard — which is why the retype is on the column without one.)
    await drift(`UPDATE protocol_instances SET template_version = 'two' WHERE id = '${inst.id}'`);

    await expect(h.run((ctx) => getProtocol(ctx, inst.id))).rejects.toThrow(
      /does not match the shape this engine publishes.*template_version/s,
    );
    await expect(staff.invoke('protocol/get', { instanceId: inst.id })).rejects.toThrow(
      /does not match the shape this engine publishes/,
    );
    // The page walk parses every entry it publishes, not just the first read.
    await expect(h.run((ctx) => listProtocolsForEntity(ctx, ORDER, {}))).rejects.toThrow(
      /does not match the shape this engine publishes.*template_version/s,
    );
    await expect(
      staff.invoke<Page<ProtocolSummary>>('protocol/list-for-entity', {
        entityType: ORDER.entityType,
        entityId: ORDER.entityId,
      }),
    ).rejects.toThrow(/does not match the shape this engine publishes/);
  });

  it('a template whose row drifted throws at the seam, before an instance pins it', async () => {
    await template();
    // `version` is INTEGER in the table and `z.number()` in the published shape;
    // SQLite keeps a non-numeric literal as text, which is exactly the retype an
    // additive-only rule exists to forbid and nothing at runtime enforced.
    await drift(`UPDATE protocol_templates SET version = 'two'`);

    await expect(instantiate()).rejects.toThrow(
      /does not match the shape this engine publishes.*version/s,
    );
    await expect(h.run((ctx) => listTemplates(ctx, {}))).rejects.toThrow(
      /does not match the shape this engine publishes/,
    );
  });

  it('a signature column renamed upstream fails at the read — the row a hash attests to', async () => {
    await template();
    const inst = await instantiate();
    await staff.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'front-brake', value: true });
    await h.run((ctx) => signProtocol(ctx, { instanceId: inst.id }));
    // Every typed column on a signature row is CHECK-guarded, so the drift a
    // signature can suffer is a rename: engine 0.4 called it `evidence`.
    await drift('ALTER TABLE protocol_signatures RENAME COLUMN evidence_ref TO evidence');

    // `SELECT *` would have published a row with `evidence` and no `evidence_ref`,
    // and a vertical reading the sealed-PDF pointer would have found `undefined`.
    await expect(h.run((ctx) => getProtocol(ctx, inst.id))).rejects.toThrow(
      /no such column: evidence_ref/,
    );
    await expect(staff.invoke('protocol/get', { instanceId: inst.id })).rejects.toThrow(
      /no such column: evidence_ref/,
    );
    // The summary reads the signatures too; a half-published one would show the
    // protocol as unsigned, which is the wrong-data failure this closes.
    await expect(h.run((ctx) => listProtocolsForEntity(ctx, ORDER, {}))).rejects.toThrow(
      /no such column: evidence_ref/,
    );
  });

  it('the seam failure is the engine’s fault, not the caller’s', async () => {
    await template();
    const inst = await instantiate();
    await drift(`UPDATE protocol_instances SET template_version = 'two'`);

    // `internal`, not `validation_failed`: the input parsed; the stored row is
    // what stopped matching. A 400 here would blame a client that sent nothing wrong.
    await expect(staff.invoke('protocol/get', { instanceId: inst.id })).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it('a row that matches still crosses, unchanged', async () => {
    await template();
    const inst = await instantiate();
    const detail = await h.run((ctx) => getProtocol(ctx, inst.id));
    expect(detail.instance).toEqual<ProtocolInstanceRow>(inst);
    expect(detail.template.content.kind).toBe('checklist');
  });
});
