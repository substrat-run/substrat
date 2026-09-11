import { describe, expect, it } from 'vitest';
import type { DeclaredEventSurface } from '@substrat-run/contracts';
import { deriveFlowGraph } from '../src/flow-graph.js';
import { deriveFlowFindings } from '../src/flow-findings.js';

const decl = (type: string, direction: 'emits' | 'consumes', moduleId = 'crm'): DeclaredEventSurface =>
  ({ moduleId, type, direction }) as DeclaredEventSurface;

const NOW = '2026-05-01T00:00:00.000Z';
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
/** An observation: seen `count` times, most recently `n` days ago. */
const seen = (type: string, n: number, count = 1) => ({ type, count, lastSeen: daysAgo(n) });

const base = {
  declaredEvents: [] as DeclaredEventSurface[],
  schedules: [] as { operation: string; cadence: { everyMinutes: number }; moduleId: string }[],
  requires: [] as string[],
  knownProviders: ['scrive', 'fortnox'],
  connections: [] as { provider: string; status: string }[],
  outbound: [] as string[],
  observed: [] as { type: string; count: number; lastSeen: string | null }[],
  observedComplete: true,
  now: NOW,
  staleAfterDays: 30,
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
      observed: [seen('seen.often', 0, 1234)],
    });
    const often = g.nodes.find((n) => n.id === 'event:seen.often')!;
    const never = g.nodes.find((n) => n.id === 'event:never.seen')!;
    expect(often.observed).toBe(1234);
    expect(often.silent).toBe(false);
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
  it('draws a node that ran and STOPPED differently from one that never ran', () => {
    // The two silences. A dashed node was never used; a stale one worked and stopped,
    // which is a change in behaviour rather than an unbuilt path — and the sublabel
    // has to carry the recency, because a count alone reads as healthy.
    const g = deriveFlowGraph({
      ...base,
      declaredEvents: [decl('stopped.type', 'emits'), decl('never.type', 'emits')],
      observed: [seen('stopped.type', 61, 4210)],
    });
    const stopped = g.nodes.find((n) => n.id === 'event:stopped.type')!;
    const never = g.nodes.find((n) => n.id === 'event:never.type')!;
    expect(stopped.stale).toBe(true);
    expect(stopped.silent).toBe(false);
    expect(stopped.sublabel).toBe('4,210 · last 61d ago');
    expect(stopped.title).toMatch(/ran and stopped, which is a different thing from never/);
    expect(never.silent).toBe(true);
    expect(never.stale).toBe(false);
  });

  it('leaves a node inside the window alone', () => {
    const g = deriveFlowGraph({
      ...base,
      declaredEvents: [decl('busy.type', 'emits')],
      observed: [seen('busy.type', 29, 7)],
    });
    const node = g.nodes.find((n) => n.id === 'event:busy.type')!;
    expect(node.stale).toBe(false);
    expect(node.sublabel).toBe('7 recorded');
  });

  it('will not call a node stale on a recency the facet could not supply', () => {
    // `lastSeen: null` is "not known", never "long ago".
    const g = deriveFlowGraph({
      ...base,
      declaredEvents: [decl('a.thing', 'emits')],
      observed: [{ type: 'a.thing', count: 5, lastSeen: null }],
    });
    const node = g.nodes.find((n) => n.id === 'event:a.thing')!;
    expect(node.stale).toBe(false);
    expect(node.observed).toBe(5);
  });

  it('never marks a node both silent and stale', () => {
    // They are mutually exclusive by construction: nothing recorded cannot also be
    // something recorded a while ago, and a node carrying both would render as both.
    const g = deriveFlowGraph({
      ...base,
      declaredEvents: [decl('a', 'emits'), decl('b', 'emits'), decl('c', 'emits')],
      observed: [seen('b', 90, 2), seen('c', 1, 2)],
    });
    for (const n of g.nodes) expect(n.silent && n.stale).toBe(false);
  });

  /**
   * The map and the list are two projections of ONE read, and the worker serves them
   * together — so a node the map colours amber must have a finding beside it, and a
   * node it leaves alone must not. They drifted apart once already: the findings pass
   * withheld every event finding under truncation while the map went on marking the
   * buckets the facet had returned, which put an amber node on screen above a sentence
   * saying nothing could be reported.
   */
  it('agrees with the findings list about staleness, truncated or not', () => {
    for (const observedComplete of [true, false]) {
      const shared = {
        declaredEvents: [
          decl('stopped.type', 'emits', 'mod-a'),
          decl('stopped.type', 'consumes', 'mod-b'),
          decl('busy.type', 'emits', 'mod-a'),
          decl('unseen.type', 'emits', 'mod-a'),
        ],
        observed: [seen('stopped.type', 61, 4210), seen('busy.type', 2, 9)],
        observedComplete,
        now: NOW,
        staleAfterDays: 30,
        knownProviders: base.knownProviders,
        requires: [],
        connections: [],
        declaredComplete: true,
      };
      const g = deriveFlowGraph({ ...shared, schedules: [], outbound: [] });
      const f = deriveFlowFindings(shared);

      const staleNodes = g.nodes.filter((n) => n.stale).map((n) => n.label).sort();
      const staleFindings = f.findings.filter((x) => x.kind === 'stale').map((x) => x.subject).sort();
      expect(staleNodes).toEqual(['stopped.type']);
      expect(staleFindings).toEqual(staleNodes);

      // And the silence side moves together too: unreportable when truncated, on both.
      const silentNodes = g.nodes.filter((n) => n.silent).map((n) => n.label);
      const absenceFindings = f.findings.filter((x) => x.kind === 'unemitted').map((x) => x.subject);
      expect(silentNodes).toEqual(observedComplete ? ['unseen.type'] : []);
      expect(absenceFindings).toEqual(observedComplete ? ['unseen.type'] : []);
    }
  });
});
