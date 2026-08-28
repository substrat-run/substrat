/**
 * Every entity check ticket0 DECLARES, driven against the handler that serves it.
 *
 * The declaration says `permission: { key: 'conversation:read', entity: 'conversation',
 * idFrom: 'conversationId' }`. Nothing in the type system makes the handler honour
 * that: `ctx.check(perm)` without the entity typechecks and lets every agent reach
 * every conversation. This generates the behavioural pair that separates the two.
 *
 * The probe holds **no role**. In this app that matters more than it does elsewhere:
 * every staff key is held scope-wide, so a probe who was an agent would pass each
 * check without the grant under test doing anything. A bare principal cannot — which
 * is what makes the grant the only thing that could have let it in.
 */
import { afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionKey, principalId, type EntityRef } from '@substrat-run/contracts';
import { entityCheckConformanceSuite } from '@substrat-run/contract-tests';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { conformance } from './conformance.js';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
/** No role, no grants — everything it can reach, this suite gave it. */
const probe = principalId.parse(ulid());
let made = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-entity-checks-'));
  host = buildHost(dir);
  world = await seed(host);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

entityCheckConformanceSuite(
  conformance.subject,
  conformance.operations,
  async () => ({
    async createEntity(entityType: string) {
      const desk = world.substrat;
      made += 1;
      if (entityType === 'conversation') {
        // Through the relay, which is how a conversation actually comes into being
        // from outside. Never a raw INSERT.
        //
        // One contact for every conversation the kit makes: `merge` refuses to fold
        // one person's thread into another's (#919), and the survivor the kit hands
        // it is a second conversation from this same factory (#939). Under one
        // contact case 1 is a merge the rule allows, not a refusal the kit tolerates.
        const relay = await host.getScope(desk.relay.principal, desk.tenant, desk.scope);
        const m = await relay.invoke<{ conversation_id: string }>('ticket0/ingest-message', {
          conversationId: null,
          contactEmail: 'conformance@example.test',
          subject: `Conformance ${made}`,
          bodyText: 'Driven by the conformance kit.',
          emailMessageId: `<conformance-${made}@mail.example>`,
        });
        return m.conversation_id;
      }
      if (entityType === 'kbSource') {
        const admin = await host.getScope(desk.admin.principal, desk.tenant, desk.scope);
        const s = await admin.invoke<{ id: string }>('ticket0/add-kb-source', {
          kind: 'markdown',
          url: `https://conformance.example/${made}.md`,
          label: `Conformance ${made}`,
        });
        return s.id;
      }
      throw new Error(`no factory for '${entityType}'`);
    },

    async grantOnEntity(permission: string, entity: EntityRef) {
      // The ADMIN grant. Setting the test up through one of the vertical's own
      // operations would make that operation's case prove only that it agrees
      // with itself.
      await host.admin.grant(world.staff, {
        principalId: probe,
        permission: permissionKey.parse(permission),
        node: { tenantId: world.substrat.tenant, scopeId: world.substrat.scope },
        entity,
        grantedBy: world.substrat.admin.principal,
      });
    },

    async invoke(operation: string, input: Record<string, unknown>) {
      const stub = await host.getScope(probe, world.substrat.tenant, world.substrat.scope);
      return stub.invoke(operation, input);
    },
  }),
  conformance,
);
