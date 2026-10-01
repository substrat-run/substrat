import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type AppRow } from '../src/lib/api';
import { SchemaHistoryCard } from '../src/views/ReleaseCards';

describe('schema history migration cost (#1763)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows recorded rows and duration, with a dash for older migrations', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(api, 'appMigrations').mockResolvedValue({
      available: true,
      migrations: [
        { moduleId: 'crm', version: '0002', appliedAt: '2026-10-01T00:00:00Z', rowsChanged: 128, durationMs: 37 },
        { moduleId: 'crm', version: '0001', appliedAt: '2026-09-01T00:00:00Z', rowsChanged: null, durationMs: null },
      ],
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<SchemaHistoryCard app={{ app_scope_id: 'S1' } as AppRow} />));
      const recorded = [...container.querySelectorAll('div')].find((row) => row.firstElementChild?.textContent?.includes('0002') && row.children.length === 4);
      const older = [...container.querySelectorAll('div')].find((row) => row.firstElementChild?.textContent?.includes('0001') && row.children.length === 4);
      expect(recorded?.children[1]?.textContent).toBe('128');
      expect(recorded?.children[2]?.textContent).toBe('37 ms');
      expect(older?.children[1]?.textContent).toBe('—');
      expect(older?.children[2]?.textContent).toBe('—');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
