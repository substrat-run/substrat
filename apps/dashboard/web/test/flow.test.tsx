import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumerId, flowLayout, highlight, nodeHealth } from '../src/lib/flow-layout';
import { MOCK_DEAD_LETTERS, MOCK_FLOW_VIEW } from '../src/lib/mock-flow';
import { Flow } from '../src/views/Flow';
import { api, type AppRow } from '../src/lib/api';

const graph = MOCK_FLOW_VIEW.graph;

describe('flowLayout (#1767)', () => {
  it('draws the six columns, and derives consumers from the consumes edges', () => {
    const l = flowLayout(graph);
    expect(l.columns.map((c) => c.label)).toEqual(['Triggers', 'Modules', 'Events', 'Consumers', 'Connections', 'Outbound hosts']);
    const consumers = l.nodes.filter((n) => n.column === 'consumer').map((n) => n.label);
    expect(consumers).toEqual(['assignment', 'digest', 'notify']);
    // A handles edge now lands on the consumer node, never back on the module.
    expect(l.edges.filter((e) => e.kind === 'consumes').every((e) => e.to.startsWith('consumer:'))).toBe(true);
    expect(l.edges.some((e) => e.from === 'event:ticket.created' && e.to === consumerId('notify'))).toBe(true);
    // The module node itself stays in its own column.
    expect(l.nodes.find((n) => n.id === 'module:notify')?.column).toBe('module');
  });

  it('keeps connections and outbound hosts apart, with no invented edges between them', () => {
    const l = flowLayout(graph);
    expect(l.nodes.filter((n) => n.column === 'egress').map((n) => n.label)).toEqual(['hooks.slack.com', 'api.fortnox.se']);
    expect(l.edges.some((e) => e.from.startsWith('connection:') || e.to.startsWith('egress:'))).toBe(false);
  });

  it('marks silence, staleness and failure differently', () => {
    expect(nodeHealth({ silent: true, stale: false, status: 'ok' })).toBe('unused');
    expect(nodeHealth({ silent: false, stale: true, status: 'ok' })).toBe('warn');
    expect(nodeHealth({ silent: true, stale: false, status: 'danger' })).toBe('fail');
    expect(nodeHealth({ silent: false, stale: false, status: 'ok' })).toBe('ok');
    const l = flowLayout(graph);
    expect(l.edges.find((e) => e.to === 'event:ticket.merged')?.dashed).toBe(true);
    expect(l.edges.find((e) => e.to === 'event:ticket.created')?.dashed).toBe(false);
  });

  it('fails a consumer a loaded dead letter names, and only that one', () => {
    const l = flowLayout(graph, MOCK_DEAD_LETTERS.slice(0, 1));
    expect(l.nodes.find((n) => n.id === consumerId('notify'))).toMatchObject({ health: 'fail', sublabel: '1 dead letter' });
    expect(l.nodes.find((n) => n.id === consumerId('digest'))?.health).toBe('ok');
  });

  it('draws a consumer health it could not read as unknown, never healthy', () => {
    const unread = flowLayout(graph, null).nodes.filter((n) => n.column === 'consumer');
    expect(unread.map((n) => n.health)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(unread[0]?.sublabel).toBe('dead letters unread');
    // An empty page that WAS read is a different answer, and says healthy.
    expect(flowLayout(graph, []).nodes.filter((n) => n.column === 'consumer').every((n) => n.health === 'ok')).toBe(true);
  });

  it('gives a dead letter naming an executor or an undeclared consumer a failing node of its own', () => {
    const [first] = MOCK_DEAD_LETTERS;
    const l = flowLayout(graph, [
      { ...first!, consumer: 'executor:mailer', eventType: 'ticket.created' },
      { ...first!, consumer: 'executor:mailer', eventType: 'ticket.created' },
      { ...first!, consumer: 'retired', eventType: 'ticket.replied' },
    ]);
    expect(l.nodes.find((n) => n.id === consumerId('executor:mailer'))).toMatchObject({ column: 'consumer', health: 'fail', sublabel: 'executor · 2 dead letters' });
    expect(l.nodes.find((n) => n.id === consumerId('retired'))).toMatchObject({ column: 'consumer', health: 'fail', sublabel: 'not declared · 1 dead letter' });
    // Fed by the event types it gave up on, so selecting it lights where they came from.
    expect(l.edges.some((e) => e.from === 'event:ticket.created' && e.to === consumerId('executor:mailer'))).toBe(true);
    expect(highlight(l.edges, consumerId('retired')).nodes.has('module:tickets')).toBe(true);
    // Every dead letter is on the map: the failing nodes account for all three.
    const onMap = l.nodes.filter((n) => n.health === 'fail' && n.column === 'consumer').map((n) => n.sublabel);
    expect(onMap).toEqual(['executor · 2 dead letters', 'not declared · 1 dead letter']);
  });

  it('lights every ancestor and descendant, and only the edges on those paths', () => {
    const l = flowLayout(graph);
    const h = highlight(l.edges, 'event:ticket.created');
    expect([...h.nodes].sort()).toEqual(['consumer:assignment', 'consumer:notify', 'event:ticket.created', 'module:tickets'].sort());
    // ticket.replied shares tickets upstream and notify downstream, but its edges are not
    // on a path through ticket.created.
    expect([...h.edges].some((e) => e.from === 'event:ticket.replied' || e.to === 'event:ticket.replied')).toBe(false);
    const deep = highlight(l.edges, consumerId('digest'));
    expect(deep.nodes.has('trigger:schedule:sla:escalate-overdue')).toBe(true);
  });
});

describe('Flow view', () => {
  let container: HTMLDivElement, root: Root;
  const app = { app_scope_id: 'S1', name: 'Acme HR', vertical_slug: 'helpdesk', status: 'active' } as AppRow;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('draws the map and the four panels from the flow read, and highlights on click', async () => {
    vi.spyOn(api, 'appFlow').mockResolvedValue(MOCK_FLOW_VIEW);
    vi.spyOn(api, 'appDeadLetters').mockResolvedValue({ entries: MOCK_DEAD_LETTERS, nextCursor: null });
    await act(async () => root.render(<Flow app={app} />));

    for (const title of ['Dead letters', 'Operation health', 'Connection usage', 'Declared vs observed']) {
      expect(container.querySelector(`section[aria-label="${title}"]`)).not.toBeNull();
    }
    // The dead letters reached the map: the consumer they name is marked failing.
    expect(container.querySelector('[data-node="consumer:notify"]')?.textContent).toContain('●');

    // A finding opens the event explorer on its type; a provider finding opens integrations.
    const findings = container.querySelector('section[aria-label="Declared vs observed"]')!;
    const hrefs = [...findings.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/observability?app=S1&view=events&type=ticket.merged');
    expect(hrefs).toContain('/apps/S1/settings/integrations');

    const node = container.querySelector('[data-node="event:ticket.created"]')!;
    await act(async () => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(node.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-node="module:tickets"]')?.hasAttribute('data-dim')).toBe(false);
    expect(container.querySelector('[data-node="connection:slack"]')?.getAttribute('data-dim')).toBe('1');
    expect(container.textContent).toContain('Open in the event explorer');

    await act(async () => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('[data-dim]')).toBeNull();
  });

  it('says a dead-letter list that failed to load is not a clean bill', async () => {
    vi.spyOn(api, 'appFlow').mockResolvedValue(MOCK_FLOW_VIEW);
    vi.spyOn(api, 'appDeadLetters').mockRejectedValue(new Error('down'));
    await act(async () => root.render(<Flow app={app} />));
    expect(container.textContent).toContain('not a statement that nothing gave up');
    expect(container.textContent).not.toContain('No delivery in this app has given up');
    // …and the map agrees: no consumer is ticked healthy over a list nobody could read.
    const consumers = [...container.querySelectorAll('[data-node^="consumer:"]')];
    expect(consumers.length).toBeGreaterThan(0);
    for (const c of consumers) {
      expect(c.textContent).toContain('?');
      expect(c.textContent).not.toContain('✓');
    }
    expect(container.textContent).toContain('? not known');
  });
});
