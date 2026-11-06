# Using them in your framework

The elements are standard web components, so the browser runs them, not your framework. Each
framework only spells attributes, properties and events slightly differently.

- **Attributes** are strings and booleans: `show="name"`, `selectable`, `page-size="50"`.
- **Properties** carry everything else: `columns`, `source`, `actions`, `query`. They hold
  functions and arrays, so they can't be attributes.
- **Events** are DOM events with a `detail`: `sub-query-change`, `sub-action-done`,
  `sub-layout-change`, `sub-sign-out`.

## At a glance

| | Set a property | Listen for an event |
|---|---|---|
| Plain JavaScript | `table.columns = columns` | `table.addEventListener('sub-query-change', fn)` |
| React 18 | through a `ref` | `addEventListener` through a `ref` |
| React 19 | `columns={columns}` | `onsub-query-change={fn}` |
| Vue | `:columns.prop="columns"` | `@sub-query-change="fn"` |
| Svelte 5 | `columns={columns}` | `onsub-query-change={fn}` |
| Angular | `[columns]="columns"` | `(sub-query-change)="fn($event)"` |

We run the elements in React 18, in `demos/todo/app`. The other rows are how those frameworks
treat any custom element, and no project in this repository exercises them. If one behaves differently, [open an issue](https://github.com/substrat-run/substrat/issues).

Vue needs telling that these tags aren't its own components:

```ts
vue({ template: { compilerOptions: { isCustomElement: (tag) => /^(sub|wa)-/.test(tag) } } });
```

Angular needs `CUSTOM_ELEMENTS_SCHEMA` on the component that uses them.

## React 18

React 18 passes everything to a custom element as an attribute, so properties and events go
through a `ref`:

```tsx
function Lists() {
  const ref = useRef<SubEntityTable>(null);

  useEffect(() => {
    const table = ref.current!;
    table.source = source;
    table.columns = columns;
    const onChange = (e: Event) => save((e as CustomEvent).detail.query);
    table.addEventListener('sub-query-change', onChange);
    return () => table.removeEventListener('sub-query-change', onChange);
  }, []);

  return <sub-entity-table ref={ref} selectable />;
}
```

`import type {} from '@substrat-run/elements/jsx'` types every `wa-*` element. Declare the `sub-*`
elements you use in your own `JSX.IntrinsicElements`; `demos/todo/app/src/elements.tsx` shows how.

## Your components inside a table cell

A column's `mount(cell, row)` hands you a light-DOM element, so your framework can render into it
and your page's CSS applies inside it. It can return `{ update, unmount }`.

```tsx
const columns = [
  {
    key: 'done',
    label: 'Done',
    mount(cell, row) {
      const root = createRoot(cell);
      root.render(<DoneToggle item={row} />);
      return {
        update: (next) => root.render(<DoneToggle item={next} />),
        // Deferred: React warns about a root unmounted during its own render.
        unmount: () => queueMicrotask(() => root.unmount()),
      };
    },
  },
];
```

For a cell that only formats a value, `kind` (`money`, `date`, `badge` and so on) needs no
framework at all.

## Routing

The elements never touch the URL, because the page owns its routing. The table tells you when its
query changes, and `queryToParams` and `queryFromParams` turn that query into parameters and back.
See [the query in the URL](/reference/elements#sub-entity-table).
