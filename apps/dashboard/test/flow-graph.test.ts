import { describe, expect, it } from 'vitest';
import type { DeclaredEventSurface } from '@substrat-run/contracts';
import { deriveFlowGraph } from '../src/flow-graph.js';

const decl = (type: string, direction: 'emits' | 'consumes', moduleId = 'crm'): DeclaredEventSurface =>
  ({ moduleId, type, direction }) as DeclaredEventSurface;

const base = {
  declaredEvents: [] as DeclaredEventSurface[],
  schedules: [] as { operation: string; cadence: { everyMinutes: number }; moduleId: string }[],
  requires: [] as string[],
  knownProviders: ['scrive', 'fortnox'],
  connections: [] as { provider: string; status: string }[],
  outbound: [] as string[],
  observed: [] as { type: string; count: number }[],
  observedComplete: true,
  declaredComplete: true,
};

describe('deriveFlowGraph (#1234)', () => {
  /**
   * The HTTP trigger draws NO edges. It used to draw one to every module, which reads as
   * "requests reach all of these" — and `ModuleRegistration.operations` is optional, so a
   * consumer-only or schedule-only module is reached by an event or the clock and never by
   * a request. Which module serves a request is an operation fact, and operations are the
   * one thing this manifest does not carry; the header disavows exactly this kind of
   * uncheckable line, and the graph was drawing `modules.length` of them.
   */
  it('leaves the HTTP trigger unattached rather than claiming requests reach every module', () => {
    const g = deriveFlowGraph({
      ...base,
      declaredEvents: [decl('invoice.sent', 'emits', 'billing'), decl('receipt.landed', 'consumes', 'ledger')],
    });
    expect(g.nodes.find((n) => n.id === 'trigger:http')).toBeDefined();
    expect(g.edges.filter((e) => e.from === 'trigger:http')).toEqual([]);
    // A DECLARED trigger still connects — the schedule says which module it runs in.
    const withSchedule = deriveFlowGraph({
      ...base,
      declaredEvents: [decl('invoice.sent', 'emits', 'billing')],
      schedules: [{ operation: 'billing/sweep', cadence: { everyMinutes: 60 }, moduleId: 'billing' }],
    });
    expect(withSchedule.edges.some((e) => e.to === 'module:billing' && e.kind === 'triggers')).toBe(true);
  });

  /**
   * A truncated declaration drops NODES, and unlike a missing count a missing node leaves
   * nothing behind to notice — so the flag has to reach the view, whose header otherwise
   * claims to draw "what this app declares".
   */
  it('carries a truncated declaration through, including when the version is too old', () => {
    expect(deriveFlowGraph({ ...base, declaredComplete: false }).declaredComplete).toBe(false);
    expect(
      deriveFlowGraph({ ...base, declaredEvents: null, declaredComplete: false }),
    ).toMatchObject({ available: false, declaredComplete: false });
  });

  it('lays the declared app out in bands, triggers above modules above events', () => {
    const g = deriveFlowGraph({
      ...base,
      declaredEvents: [decl('invoice.sent', 'emits', 'billing')],
      schedules: [{ operation: 'billing/sweep', cadence: { everyMinutes: 60 }, moduleId: 'billing' }],
      requires: ['scrive'],
      connections: [{ provider: 'scrive', status: 'active' }],
    });
    const y = (id: string) => g.nodes.find((n) => n.id === id)!.y;
    expect(y('trigger:http')).toBeLessThan(y('module:billing'));
    expect(y('module:billing')).toBeLessThan(y('event:invoice.sent'));
    expect(y('event:invoice.sent')).toBeLessThan(y('connection:scrive'));
    expect(g.height).toBeGreaterThan(0);
  });

  it('draws no edge into the outside band, because nothing declares which module uses it', () => {
    // `requires` and `outbound` are declared by the vertical, not by a module. An edge
    // from any one module would be invented; from every module it would assert the same
    // untrue thing about each. Band membership carries the whole declared fact.
    const g = deriveFlowGraph({
      ...base,
      declaredEvents: [decl('a.thing', 'emits', 'mod-a')],
      requires: ['scrive'],
      outbound: ['api.example.com'],
    });
    expect(g.nodes.map((n) => n.id)).toContain('connection:scrive');
    expect(g.nodes.map((n) => n.id)).toContain('egress:api.example.com');
    expect(g.edges.filter((e) => e.to.startsWith('connection:') || e.to.startsWith('egress:'))).toEqual([]);
  });

  it('marks a declared event nothing has recorded as silent, and carries counts for the rest', () => {
    const g = deriveFlowGraph({
      ...base,
      declaredEvents: [decl('seen.often', 'emits'), decl('never.seen', 'emits')],
      observed: [{ type: 'seen.often', count: 1234 }],
    });
    const seen = g.nodes.find((n) => n.id === 'event:seen.often')!;
    const never = g.nodes.find((n) => n.id === 'event:never.seen')!;
    expect(seen.observed).toBe(1234);
    expect(seen.silent).toBe(false);
    expect(never.observed).toBe(0);
    expect(never.silent).toBe(true);
    expect(g.partialObservation).toBe(false);
  });

  it('will not draw proven silence on an incomplete observation', () => {
    // The load-bearing case for the overlay. A truncated facet yields no count for a
    // type, which looks exactly like zero — and drawing it as silence would invent the
    // one finding this whole view exists to make.
    const g = deriveFlowGraph({
      ...base,
      declaredEvents: [decl('uncounted', 'emits')],
      observed: [],
      observedComplete: false,
    });
    const node = g.nodes.find((n) => n.id === 'event:uncounted')!;
    expect(node.observed).toBeNull();
    expect(node.silent).toBe(false);
    expect(node.sublabel).toBe('not counted');
    expect(g.partialObservation).toBe(true);
  });

  it('draws a consume edge back up from the event to the handler', () => {
    const g = deriveFlowGraph({
      ...base,
      declaredEvents: [decl('x.y', 'emits', 'producer'), decl('x.y', 'consumes', 'handler')],
    });
    expect(g.edges).toContainEqual({
      from: 'module:producer',
      to: 'event:x.y',
      kind: 'emits',
      title: 'producer emits x.y',
    });
    expect(g.edges).toContainEqual({
      from: 'event:x.y',
      to: 'module:handler',
      kind: 'consumes',
      title: 'handler handles x.y',
    });
    // One node for the type, however many modules declare it.
    expect(g.nodes.filter((n) => n.kind === 'event')).toHaveLength(1);
  });

  it('colours a connection by whether it is usable, not merely by whether it exists', () => {
    const g = deriveFlowGraph({
      ...base,
      declaredEvents: [],
      requires: ['scrive', 'fortnox'],
      connections: [{ provider: 'scrive', status: 'expired' }],
    });
    const scrive = g.nodes.find((n) => n.id === 'connection:scrive')!;
    const fortnox = g.nodes.find((n) => n.id === 'connection:fortnox')!;
    // A lapsed connection and one never made are different states and different fixes.
    expect(scrive.status).toBe('danger');
    expect(scrive.sublabel).toBe('needs reconnecting');
    expect(fortnox.status).toBe('warn');
    expect(fortnox.sublabel).toBe('not connected');
    // And the copy still refuses to say an unconnected provider fails.
    expect(fortnox.title).toMatch(/waits rather than failing/);
  });

  it('leaves out a required capability that is not a connectable provider', () => {
    const g = deriveFlowGraph({ ...base, requires: ['oidc-issuer'] });
    expect(g.nodes.filter((n) => n.kind === 'connection')).toEqual([]);
  });

  it('makes no claim about whether an egress host has been used', () => {
    // Nothing counts egress per host today, so "nothing has used this" is a finding
    // the graph cannot support — and must not imply by colouring it like a silent event.
    const g = deriveFlowGraph({ ...base, outbound: ['api.example.com'] });
    const host = g.nodes.find((n) => n.id === 'egress:api.example.com')!;
    expect(host.silent).toBe(false);
    expect(host.status).toBe('ok');
    expect(host.observed).toBeNull();
    expect(host.title).toMatch(/permitted to reach/);
  });

  it('says UNAVAILABLE rather than drawing an app that emits nothing', () => {
    const g = deriveFlowGraph({ ...base, declaredEvents: null, requires: ['scrive'] });
    expect(g.available).toBe(false);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });

  it('wraps a band too wide for the canvas instead of shrinking the labels', () => {
    const many = Array.from({ length: 40 }, (_, i) => decl(`type.number.${i}`, 'emits'));
    const g = deriveFlowGraph({ ...base, declaredEvents: many });
    const events = g.nodes.filter((n) => n.kind === 'event');
    expect(new Set(events.map((n) => n.y)).size).toBeGreaterThan(1);
    expect(g.width).toBeLessThanOrEqual(1000);
    // Still below the module band it hangs off, wrapped or not.
    const moduleY = g.nodes.find((n) => n.kind === 'module')!.y;
    expect(Math.min(...events.map((n) => n.y))).toBeGreaterThan(moduleY);
  });

  it('reads a cadence the way a person would say it', () => {
    const g = deriveFlowGraph({
      ...base,
      schedules: [
        { operation: 'a', cadence: { everyMinutes: 60 }, moduleId: 'm' },
        { operation: 'b', cadence: { everyMinutes: 1440 }, moduleId: 'm' },
        { operation: 'c', cadence: { everyMinutes: 15 }, moduleId: 'm' },
      ],
    });
    expect(g.nodes.filter((n) => n.kind === 'trigger').map((n) => n.sublabel)).toEqual([
      'on demand',
      'hourly',
      'daily',
      'every 15 min',
    ]);
  });
});
