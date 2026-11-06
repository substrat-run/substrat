/**
 * The screens: the one file a vertical rewrites. One entry per line of the concept's
 * Screens section. `render` is a Lit template, so `.prop=${…}` sets an element's property
 * and `@event=${…}` listens to it.
 */
import type { Column } from '@substrat-run/elements';
import { html, type TemplateResult } from 'lit';
import { invoke, pagedRead } from './api.js';

export interface Screen {
  /** The route after `#/`; the first screen answers an empty hash. */
  path: string;
  label: string;
  render(): TemplateResult;
}

interface Item {
  id: string;
  name: string;
  created_at: string;
}

// Module constants on purpose: the table owns its query, and a new `source` starts it over.
const ITEMS = pagedRead<Item>('/api/items');
const ITEM_COLUMNS: Column<Item>[] = [
  { key: 'name', label: 'Name', sort: 'name' },
  { key: 'created_at', label: 'Created', kind: 'relative' },
];

async function addItem(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  try {
    await invoke('acme/add-item', { name: new FormData(form).get('name') });
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
    return;
  }
  form.reset();
  location.reload();
}

export const screens: Screen[] = [
  {
    path: 'items',
    label: 'Items',
    render: () => html`
      <h1>Items</h1>
      <form class="row" @submit=${addItem}>
        <wa-input name="name" label="Name" required></wa-input>
        <wa-button type="submit" variant="brand">Add</wa-button>
      </form>
      <sub-entity-table label="Items" empty="Nothing here yet." .source=${ITEMS} .columns=${ITEM_COLUMNS}></sub-entity-table>
    `,
  },
];
