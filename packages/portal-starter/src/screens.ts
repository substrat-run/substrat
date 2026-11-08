/**
 * The screens: the one file a vertical rewrites. One entry per line of the concept's
 * Screens section. `render` is a Lit template, so `.prop=${…}` sets an element's property
 * and `@event=${…}` listens to it.
 */
import type { Column, RowAction } from '@substrat-run/elements';
import { html, type TemplateResult } from 'lit';
import { invoke, loaded, pagedRead } from './api.js';

export interface Screen {
  /** The route after `#/`; the first screen answers an empty hash. */
  path: string;
  label: string;
  /** False for a screen reached from another, such as one record: it stays out of the top bar. */
  nav?: boolean;
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

/** A value from the hash's query, as in `#/item?id=…`. */
const param = (name: string): string | null => new URLSearchParams(location.hash.split('?')[1] ?? '').get(name);

/**
 * A row opens its record, and a row click does nothing else. An action on one row (tick it,
 * delete it, revoke it) is a row action: `.actions` puts it in the row as a button, and the table
 * runs it and reloads. `row-click` turns row clicks on, and `sub-row-click` carries the row.
 */
const openItem = (event: CustomEvent<{ row: Item }>): void => {
  location.hash = `#/item?id=${encodeURIComponent(event.detail.row.id)}`;
};

/** What a person does to one item, right in its row. */
const ITEM_ACTIONS: RowAction<Item>[] = [
  { id: 'delete', label: 'Delete', tone: 'danger', run: (row) => invoke('acme/delete-item', { id: row.id }) },
];

async function deleteItem(id: string): Promise<void> {
  if (!confirm('Delete this item?')) return;
  try {
    await invoke('acme/delete-item', { id });
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
    return;
  }
  location.hash = '#/items';
}

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
  // A table keeps the rows it loaded, and re-rendering the screen keeps the table: reload the one
  // this action changed, or the new item shows only after the page is reloaded.
  await document.querySelector<HTMLElement & { reload(): Promise<void> }>('sub-entity-table[label="Items"]')?.reload();
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
      <sub-entity-table label="Items" empty="Nothing here yet." .source=${ITEMS} .columns=${ITEM_COLUMNS}
        .actions=${ITEM_ACTIONS} row-click @sub-row-click=${openItem}></sub-entity-table>
    `,
  },
  {
    path: 'item',
    label: 'Item',
    nav: false,
    render: () => {
      const id = param('id') ?? '';
      return html`
        <p><a href="#/items">Back to items</a></p>
        ${loaded(
          () => invoke<Item>('acme/get-item', { id }),
          (item) => html`
            <h1>${item.name}</h1>
            <wa-button variant="danger" @click=${() => deleteItem(item.id)}>Delete</wa-button>
          `,
        )}
      `;
    },
  },
];
