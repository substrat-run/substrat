/**
 * Fixtures for `role-seat-paths.mjs` (#2447): a host path that seats or defines a role without the
 * reserved-key rule is reported, and each guarded twin is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUnguardedSeats } from './role-seat-paths.mjs';

const PATH = 'packages/adapter-sqlite/src/fixture.ts';
const run = (text, allowed = {}, path = PATH) => findUnguardedSeats([{ path, text }], allowed);

test('a role tuple seated with no refusal before it is reported, naming its function', () => {
  const out = run(`class H {
  async seatOwner(owner, roleKey) {
    this.write(\`principal:\${owner}\`, \`role:\${roleKey}\`, 'scope:s');
  }
}`);
  assert.equal(out.length, 1);
  assert.match(out[0], /fixture\.ts:3: a role tuple is written in seatOwner with no reservedRoleRefusal \(or an adapter's wrapper of one\) acted on before it/);
});

test('its twin: a refusal asked first in the same function covers it', () => {
  assert.deepEqual(
    run(`class H {
  async seatOwner(owner, roleKey, role) {
    const refusal = reservedRoleRefusal(role, this.reservedKeys, 'person');
    if (refusal) throw new Error(refusal);
    this.write(\`principal:\${owner}\`, \`role:\${roleKey}\`, 'scope:s');
  }
}`),
    [],
  );
});

test('a refusal asked AFTER the write, or in a sibling function, does not cover it', () => {
  assert.equal(
    run(`class H {
  async seat(owner, roleKey, role) {
    this.write(\`principal:\${owner}\`, \`role:\${roleKey}\`, 'scope:s');
    reservedRoleRefusal(role, this.reservedKeys, 'person');
  }
}`).length,
    1,
  );
  assert.equal(
    run(`class H {
  judge(role) { return reservedRoleRefusal(role, this.reservedKeys, 'person'); }
  seat(owner, roleKey) { this.write(\`principal:\${owner}\`, 'role:' + roleKey, 'scope:s'); }
}`).length,
    1,
  );
});

test('a declaration of a guard name is not a guard: an interface method and a method head ask nothing', () => {
  const out = run(`interface Stub {
  reservedRoleRefusalFor(tenantId: string, roleKey: string): Promise<string | null>;
}
class H {
  private async refuseReservedRole(role) {}
  seat(owner, roleKey) { this.write(\`principal:\${owner}\`, \`role:\${roleKey}\`, 'scope:s'); }
}`);
  assert.equal(out.length, 1);
});

test('a write of the role table is a definition: reported unguarded, covered by the definition rule', () => {
  const sql = "db.prepare('INSERT OR REPLACE INTO _substrat_roles (tenant_id, role_key) VALUES (?, ?)').run(t, role.key);";
  assert.match(run(`const admin = { defineRole: async (t, role) => { ${sql} } };`)[0], /a role definition \(the role table\) is written in defineRole/);
  assert.deepEqual(
    run(`const admin = { defineRole: async (t, role) => { refuseReservedDefinition(t, role); ${sql} } };`),
    [],
  );
});

test('the kernel scope-role writers and a ScopeDO projection are seats; their guarded twins are not', () => {
  assert.match(run(`function assignBounded(sql, s, who, roleKey) { applyScopeRoleChange(sql, s, who, { revoke: [], grant: roleKey }); }`)[0], /a scope role \(applyScopeRoleChange\)/);
  assert.match(run(`async function provision(stub, roles) { await stub.applyProjectionReply('t', roles, []); }`)[0], /a role definition \(applyProjectionReply\) is written in provision/);
  assert.deepEqual(
    run(`async function provision(stub, roles) { await this.refuseReservedRoleSet(roles, 's'); await stub.applyProjectionReply('t', roles, []); }`),
    [],
  );
  // Its own declaration, and an import of the kernel writer, are not calls.
  assert.deepEqual(run(`import { applyScopeRoleChange } from 'k';\nexport function applyScopeRoleChange(sql) { return sql; }`), []);
});

test('an allowlisted function passes; an entry whose function seats nothing unguarded is stale and refused', () => {
  const revoke = `class H {
  async revokeScopeRole(s, who, roleKey) { return this.stub.revokeTuple(\`principal:\${who}\`, \`role:\${roleKey}\`, \`scope:\${s}\`); }
}`;
  assert.deepEqual(run(revoke, { [`${PATH}#revokeScopeRole`]: 'a revoke' }), []);
  assert.match(run('class H { other() {} }', { [`${PATH}#revokeScopeRole`]: 'a revoke' })[0], /#revokeScopeRole: an ALLOWED entry whose function seats nothing unguarded any more/);
  // An entry for a file not read this run is not judged.
  assert.deepEqual(run('class H {}', { 'packages/adapter-sqlite/src/elsewhere.ts#x': 'a revoke' }), []);
});

test('a callback names no function: the seat is judged as part of the named function around it', () => {
  const out = run(`class H {
  async seatAll(owners, roleKey) {
    await this.turn(() => {
      for (const o of owners) this.write(\`principal:\${o}\`, \`role:\${roleKey}\`, 'scope:s');
    });
  }
}`);
  assert.match(out[0], /written in seatAll/);
});

test('only host source is read: a test file and another package are out of scope', () => {
  const seat = 'function seat(o, k) { write(`role:${k}`); }';
  assert.deepEqual(run(seat, {}, 'packages/adapter-sqlite/test/fixture.test.ts'), []);
  assert.deepEqual(run(seat, {}, 'engines/workorder/src/index.ts'), []);
  assert.equal(run(seat, {}, 'packages/vertical-host/src/index.ts').length, 1);
});

test('prose naming a seat in a comment is not one', () => {
  assert.deepEqual(run('// writes `role:${key}` and INSERT INTO _substrat_roles\nconst x = 1;'), []);
});

test('a guard whose answer is dropped covers nothing (M2): assigned but never tested, or called for nothing', () => {
  const write = "db.prepare('INSERT OR REPLACE INTO _substrat_roles (tenant_id, role_key) VALUES (?, ?)').run(t, role.key);";
  assert.equal(run(`class D { defineRole(t, role, r, d) { const refused = reservedRoleDefinitionRefusal(role, r, d); void refused; ${write} } }`).length, 1);
  assert.equal(run(`class D { defineRole(t, role, r, d) { reservedRoleDefinitionRefusal(role, r, d); ${write} } }`).length, 1);
  // A test AFTER the write does not cover it either.
  assert.equal(run(`class D { defineRole(t, role, r, d) { const refused = reservedRoleDefinitionRefusal(role, r, d); ${write} if (refused) return { refused }; } }`).length, 1);
  // The twin: assigned and tested before the write.
  assert.deepEqual(run(`class D { defineRole(t, role, r, d) { const refused = reservedRoleDefinitionRefusal(role, r, d); if (refused) return { refused }; ${write} } }`), []);
  // A guard nested in a ternary initializer, or a returned answer, is acted on too.
  assert.deepEqual(run(`class D { seat(o, k, role, r) { const refusal = role ? reservedRoleRefusal(role, r, 'person') : null; if (refusal) throw new Error(refusal); write(\`role:\${k}\`); } }`), []);
});

test('a guard covers only its own kind of write (M3): a seat refusal does not cover a projected role set', () => {
  const out = run(`class H {
  async provision(input, owner, stub, reserved) {
    const ownerRefusal = reservedRoleRefusal(owner, reserved, 'person');
    if (ownerRefusal) throw new Error(ownerRefusal);
    await stub.applyProjectionReply(input.tenantId, input.roles, [{ relation: \`role:\${input.ownerRoleKey}\` }]);
  }
}`);
  assert.equal(out.length, 1);
  assert.match(out[0], /a role definition \(applyProjectionReply\) is written in provision with no reservedRoleDefinitionRefusal/);
  // The twin: the set refused first as well.
  assert.deepEqual(
    run(`class H {
  async provision(input, owner, stub, reserved) {
    await this.refuseReservedRoleSet(input.roles, input.tenantId, input.scopeId);
    const ownerRefusal = reservedRoleRefusal(owner, reserved, 'person');
    if (ownerRefusal) throw new Error(ownerRefusal);
    await stub.applyProjectionReply(input.tenantId, input.roles, [{ relation: \`role:\${input.ownerRoleKey}\` }]);
  }
}`),
    [],
  );
});

test('an UPDATE of the role table is a definition write', () => {
  const sql = "db.prepare('UPDATE _substrat_roles SET permissions = ? WHERE role_key = ?').run(p, k);";
  assert.match(run(`function widen(p, k) { ${sql} }`)[0], /a role definition \(the role table\) is written in widen/);
  assert.deepEqual(run(`function widen(t, role, p, k) { refuseReservedDefinition(t, role); ${sql} }`), []);
});

test('a write inside \`if (!r)\` is the admitted branch of an acted-on answer, not a false positive (round 2)', () => {
  assert.deepEqual(run(`class S { seat(o, k, role, r) { const refusal = reservedRoleRefusal(role, r, 'person'); if (!refusal) { write(\`role:\${k}\`); } } }`), []);
  // A different name tested does not count.
  assert.equal(run(`class S { seat(o, k, role, r, other) { const refusal = reservedRoleRefusal(role, r, 'person'); if (!other) { write(\`role:\${k}\`); } } }`).length, 1);
});
