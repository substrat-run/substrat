# Building screens

Substrat has no opinion about your UI. A vertical's API is the contract: the model declares its
reads and operations, the platform serves them over HTTP, and anything that speaks HTTP can be
the front end. Pick React, Vue, Svelte, plain HTML, or a phone app. Nothing in the kernel, the
engines or `substrat push` knows or cares which.

`@substrat-run/elements` is there because business apps ask the same hard questions on every
screen, and answering them is not what makes your app yours. It is a small set of web components
that answer them for you, and it is optional. Use one element, all of them, or none.

## What the elements handle

- **Theming.** Every colour, size and font comes from one set of tokens, so a theme is a list of
  values and the whole app follows it, in light and in dark. See [Theming](/elements/theming).
- **Reading a list properly.** Sorting, filtering, search and paging run on the server, and paging
  stays a keyset walk, so rows don't drop or repeat while someone writes.
- **Telling states apart.** A 403 shows a wall rather than an empty list, "no matches" is a
  different message from "nothing here", and a refused action keeps the rows on screen.
- **Stale views.** When an action finds the row has changed or gone (409 or 404), the table reads
  the view again.
- **Who is signed in.** One session read per page, shared by every element on it. Nothing shows
  "Sign in" to someone who is signed in and merely not read yet, and going offline doesn't look
  like signing out.
- **Keyboards, screen readers and narrow screens.** Anything a drag can do has a button, and
  columns give way in the order you declared when the frame runs out of room.

## What's in the package

| Element | What it is |
|---|---|
| [`<sub-entity-table>`](/reference/elements#sub-entity-table) | The rows of one paged read: views, sort, filters, search, selection, bulk actions and an opt-in column picker |
| [`<sub-user-menu>`](/reference/elements#sub-user-menu) | The account menu, including signing in, switching user and signing out |
| [`<sub-avatar>`](/reference/elements#sub-avatar) | The same identity without the menu |

Around those sit [Web Awesome's controls](/elements/web-awesome): buttons, inputs, selects,
dropdowns and the rest of a form.

## A first screen

```sh
npm install @substrat-run/elements
```

```ts
import '@substrat-run/elements';
import '@substrat-run/elements/themes/base.css';
import { api } from './api.generated';

const table = document.querySelector('sub-entity-table');
table.source = {
  read: ({ sort, order, limit }) => api.myLists({ sort, order, limit }),
  follow: (next) => api.follow(next),
};
table.columns = [
  { key: 'name', label: 'List', sort: 'name' },
  { key: 'created_at', label: 'Created', kind: 'relative', sort: 'created_at' },
];
```

`api.generated` is the [browser client generated from your model](/concepts/model), so a sort on a
column with no index behind it doesn't compile. The table works from any object with the same
shape: a `read` that takes a query and a `follow` for the `next` link. It doesn't need the
generated client, or a Substrat API.

`demos/todo/app` is the working example, in React.

## When not to use them

Your own component library is a good reason to skip them. So is a screen that isn't a list of
records or a form: a calendar, a map, a canvas. The elements read your vertical's API the same
way your own code would, so you lose nothing by writing a screen yourself, and you can mix the two
in one app.

The package is still `0.x`: a minor release may change an element's attributes or slots.

## Next

- [Using them in your framework](/elements/frameworks)
- [Theming](/elements/theming)
- [Web Awesome](/elements/web-awesome)
- [The element reference](/reference/elements)
