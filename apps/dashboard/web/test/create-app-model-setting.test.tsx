import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestOk } from '@substrat-run/ui/wa';
import type { CatalogEntry, ModelCatalogOption } from '../src/lib/api';
import { CreateApp } from '../src/views/CreateApp';
import { button, choose } from './wa';

const LISTED = 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fp8';
const model = (id: string, label: string): ModelCatalogOption => ({
  id, label, status: 'active', servedBy: 'Cloudflare Workers AI',
  tiers: [{ upToInputTokens: null, inputPer1M: '0.1', outputPer1M: '0.2', cacheReadPer1M: null, cacheWritePer1M: null }],
});
const widgets = {
  slug: 'acme/widgets', name: 'Widgets', listed: true, owned: false, installable: true,
  envSpec: [{ key: 'MODEL', kind: 'model', label: 'Assistant model', required: true, secret: false, default: 'cloudflare:@cf/unlisted/default' }],
  provides: [], requires: [],
} as unknown as CatalogEntry;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('takes a model setting through the catalog picker on the install form (#1054)', async () => {
  const onCreate = vi.fn(async () => {});
  const loadModelCatalog = vi.fn(async () => [model(LISTED, 'Llama 3.1 8B Instruct fp8'), model('qwen:qwen3.6-flash', 'Qwen 3.6 Flash')]);
  await act(async () => {
    root.render(
      <CreateApp catalog={requestOk([widgets])} authServers={[]} onCancel={() => {}} onCreate={onCreate} loadModelCatalog={loadModelCatalog} />,
    );
  });
  await act(async () => button('Install')!.click());

  // A picker, not a text field: the catalog's models are its options, and an unlisted declared
  // default is not preselected (the install would refuse it).
  const picker = [...container.querySelectorAll('wa-select')].find((s) => s.textContent?.includes('Llama 3.1 8B Instruct fp8'));
  expect(picker).toBeDefined();
  expect(picker!.textContent).toContain('Choose a model');
  expect(container.querySelector('wa-input[label^="Assistant model"]')).toBeNull();
  expect(loadModelCatalog).toHaveBeenCalledOnce();

  await act(async () => choose(picker!, LISTED));
  await act(async () => button('Create app')!.click());
  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ verticalSlug: 'acme/widgets', config: { MODEL: LISTED } }));
});
