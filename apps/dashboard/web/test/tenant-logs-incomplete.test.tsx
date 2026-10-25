import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantLogs } from '../src/views/ObservabilityPanels';
import { InvocationLogsStrip } from '../src/views/InvocationLogsStrip';
import { api, type ObservabilityLogEvent } from '../src/lib/api';
import { appLogsPanelOf, LOGS_EMPTY_INCOMPLETE, LOGS_INCOMPLETE_NOTICE } from '../src/lib/logs-panel';

/**
 * #2521: an app's Logs panel and a call's log strip say so when the plane marked the page they
 * answered as possibly missing lines (`x-substrat-logs-incomplete`), and say nothing otherwise.
 * The read is stubbed at the client's own seam; the header reading is in `observability-client`.
 */

const line = (message: string): ObservabilityLogEvent =>
  ({ timestamp: 1_722_700_000_000, level: 'info', message, service: 'acme-widgets-v1', outcome: 'ok', trigger: null, invocation: null, entrypoint: null, requestId: null, cpuTimeMs: null, wallTimeMs: null, raw: {} }) as ObservabilityLogEvent;

describe('appLogsPanelOf, pure', () => {
  it('shows the notice only on an answered, incomplete page', () => {
    expect(appLogsPanelOf(null)).toEqual({ notice: false, emptyIncomplete: false });
    expect(appLogsPanelOf({ events: [line('a')], incomplete: false })).toEqual({ notice: false, emptyIncomplete: false });
    expect(appLogsPanelOf({ events: [line('a')], incomplete: true })).toEqual({ notice: true, emptyIncomplete: false });
  });

  it('an empty page that may be incomplete does not claim the window held nothing', () => {
    expect(appLogsPanelOf({ events: [], incomplete: true })).toEqual({ notice: true, emptyIncomplete: true });
    expect(appLogsPanelOf({ events: [], incomplete: false })).toEqual({ notice: false, emptyIncomplete: false });
  });
});

describe('the app Logs panel and the call strip', () => {
  let container: HTMLDivElement, root: Root;
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

  // A fresh mount per read: the panels read in an effect keyed on their props.
  let mounts = 0;
  const panel = async () => {
    await act(async () => root.render(<TenantLogs key={mounts++} teamId="team-a" scopeId="app-a" hours={24} nonce={0} />));
  };
  const strip = async () => {
    await act(async () =>
      root.render(<InvocationLogsStrip key={mounts++} teamId="team-a" scopeId="app-a" invocationId="01J8Z3KX0Q5R7T9V1W2Y4A6B8C" occurredAt={new Date().toISOString()} />),
    );
  };

  it('the panel: the notice above the lines of an incomplete page, none on a complete one', async () => {
    const read = vi.spyOn(api, 'appTenantLogsRead').mockResolvedValue({ events: [line('first')], incomplete: true });
    await panel();
    expect(container.textContent).toContain(LOGS_INCOMPLETE_NOTICE);
    expect(container.textContent).toContain('first');
    read.mockResolvedValue({ events: [line('first')], incomplete: false });
    await panel();
    expect(container.textContent).not.toContain(LOGS_INCOMPLETE_NOTICE);
    expect(container.textContent).toContain('first');
  });

  it('the panel: an empty page that may be incomplete does not say the window was quiet', async () => {
    const read = vi.spyOn(api, 'appTenantLogsRead').mockResolvedValue({ events: [], incomplete: true });
    await panel();
    expect(container.textContent).toContain(LOGS_EMPTY_INCOMPLETE);
    expect(container.textContent).not.toContain('No log events in this window');
    read.mockResolvedValue({ events: [], incomplete: false });
    await panel();
    expect(container.textContent).toContain('No log events in this window');
    expect(container.textContent).not.toContain(LOGS_EMPTY_INCOMPLETE);
  });

  it('the call strip: the same notice, from the same read', async () => {
    const read = vi.spyOn(api, 'appTenantLogsRead').mockResolvedValue({ events: [line('first')], incomplete: true });
    await strip();
    expect(container.textContent).toContain(LOGS_INCOMPLETE_NOTICE);
    read.mockResolvedValue({ events: [line('first')], incomplete: false });
    await strip();
    expect(container.textContent).not.toContain(LOGS_INCOMPLETE_NOTICE);
    expect(container.textContent).toContain('first');
  });
});
