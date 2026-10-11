/**
 * The fixture behind `bindingInviteContractSuite` (#1686): one record type whose own column
 * names its person — the shape of a support desk's contact, a shop's customer.
 *
 * - `brecord` — `bind_records (id, principal, email, fate)`. `principal` is the binding column,
 *   an erasure SUBJECT beside `id`, never `erasable`; `email` is erasable.
 * - The hook reads the records by `principal` and logs what it saw (`bind_seen`), so the suite
 *   can see that the erasure's unbind waited for it; a record whose `fate` is `'drop'` is
 *   DELETED by it, so the suite can see a record the hook removed still released.
 *
 * Operations are thin pass-throughs and check nothing themselves, except `bind/read`, which is
 * the portal read a bound person makes: `bind:read-own` on that one record.
 */
import { z } from 'zod';
import {
  defineEntities,
  manifestEntities,
  moduleManifest,
  permissionKey,
  type EntityGrantShape,
} from '@substrat-run/contracts';
import { assertAllowed, type ModuleRegistration, type OnSubjectErased, type OperationHandler } from '@substrat-run/kernel';
import { testOperations } from './test-operations.js';

export const BIND_READ_OWN = permissionKey.parse('bind:read-own');
export const BIND_INVITE = permissionKey.parse('bind:invite');
export const BIND_MEMBER = permissionKey.parse('bind:member');
/** A key the shape used to carry — what an unbind must take back too. */
export const BIND_OLD = permissionKey.parse('bind:old');

export const bindEntities = defineEntities({
  brecord: {
    table: 'bind_records',
    fields: z.object({ id: z.string(), principal: z.string().nullable(), email: z.string().nullable(), fate: z.string().nullable() }),
    erasable: ['email'],
    erasure: { subjects: ['id', 'principal'] },
  },
  /** What the erasure hook saw, by principal — written only by the hook. */
  bseen: {
    table: 'bind_seen',
    fields: z.object({ subject: z.string(), record_id: z.string() }),
    primaryKey: ['subject', 'record_id'],
  },
});

export const bindModManifest = moduleManifest.parse({
  id: '@test/bind',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'bind:read-own', description: 'read one record — the one that names you' },
    { key: 'bind:invite', description: 'invite a record’s person, or unbind them' },
    { key: 'bind:member', description: 'be a member of the scope' },
    { key: 'bind:old', description: 'a key the shape retired' },
  ],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  entitlementKey: 'bind',
  ...manifestEntities(bindEntities, {}),
});

/** The binding shape, as a vertical's `ENTITY_GRANTS` declares it. */
export const BIND_SHAPE: EntityGrantShape = {
  entityType: 'brecord',
  permissions: [BIND_READ_OWN],
  bootstrap: true,
  holder: { table: 'bind_records', idColumn: 'id', principalColumn: 'principal' },
  retired: [BIND_OLD],
  bind: { permission: BIND_INVITE },
};

/** A binding shape over `bind_dups`, whose `key` two rows may share. */
export const BIND_DUP_SHAPE: EntityGrantShape = {
  entityType: 'bdup',
  permissions: [BIND_READ_OWN],
  bootstrap: true,
  holder: { table: 'bind_dups', idColumn: 'key', principalColumn: 'holder' },
  bind: { permission: BIND_INVITE },
};

const onSubjectErased: OnSubjectErased = (ctx, { subjectId }) => {
  const mine = ctx.sql.query<{ id: string; fate: string | null }>('SELECT id, fate FROM bind_records WHERE principal = ?', [subjectId]);
  for (const r of mine) ctx.sql.exec('INSERT INTO bind_seen (subject, record_id) VALUES (?, ?)', [subjectId, r.id]);
  ctx.sql.exec("DELETE FROM bind_records WHERE (id = ? OR principal = ?) AND fate = 'drop'", [subjectId, subjectId]);
};

type Handler = OperationHandler<never, unknown>;

export const bindMod: ModuleRegistration = {
  manifest: bindModManifest,
  migrations: [
    {
      version: '0001-init',
      // The index a vertical naturally has on its binding column — its portal and erasure find
      // rows by it — and the one that makes a Durable Object's write count read one row as two.
      sql: `CREATE TABLE bind_records (id TEXT PRIMARY KEY, principal TEXT, email TEXT, fate TEXT);
            CREATE INDEX bind_records_by_principal ON bind_records (principal);
            -- A holder table whose id is NOT unique: what a careless declaration can point at.
            CREATE TABLE bind_dups (key TEXT NOT NULL, holder TEXT);
            CREATE TABLE bind_seen (subject TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY (subject, record_id));`,
    },
  ],
  ...testOperations({
    /** Write a fixture row: `{ sql, params }` against the module's own tables. */
    'bind/put': ((ctx, input: { sql: string; params?: (string | null)[] }) => {
      ctx.sql.exec(input.sql, input.params ?? []);
    }) as Handler,
    /** Read rows back, the spine included: `{ sql, params }`. */
    'bind/sql': ((ctx, input: { sql: string; params?: (string | null)[] }) => ctx.sql.query(input.sql, input.params ?? [])) as Handler,
    /** The bound person's portal read: their own record, and nobody else's. */
    'bind/read': (async (ctx, input: { id: string }) => {
      assertAllowed(await ctx.check(BIND_READ_OWN, { entityType: 'brecord', entityId: input.id }));
      return ctx.sql.query('SELECT id FROM bind_records WHERE id = ?', [input.id])[0] ?? null;
    }) as Handler,
  }),
  onSubjectErased,
};
