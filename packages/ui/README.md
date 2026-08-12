# @substrat-run/ui

Substrat design-system primitives — the shared React component library + tokens, reused by the
[Console](https://substrat.net/platform/console) and the
[Dashboard](https://substrat.net/platform/dashboard).

**Internal to this monorepo — not published to npm.** Both consumers are private apps
(`apps/console`, `apps/dashboard/web`) and depend on it through the workspace.

## What's in it

- **Components** — `Button`, `IconButton`, `Input`, `Select`, `Checkbox`, `RadioGroup`,
  `Switch`, `Card`, `Table`, `Tabs`, `Dialog`, `Toast`, `Tooltip`, `Badge`, `Tag`,
  `Breadcrumbs`, `SideNav`, `KeyValue`, `EmptyState`, and an `icons` set.
- **Hooks** — `useAutoRefresh`, the shared polling helper for live control-plane views.
- **Tokens** — `colors`, `spacing`, `typography`, `effects`, `fonts` as plain CSS custom
  properties.

## Using it

```ts
import { Button, Table } from '@substrat-run/ui';
import '@substrat-run/ui/styles.css';          // tokens + base styles
```

Individual token sheets are reachable at `@substrat-run/ui/tokens/*` for apps that want the
variables without the component styles.

## Source-exported

`exports` points at `src` — the consuming app's Vite build compiles the TSX. There is no build
step here, which is why the two apps share components without a publish cycle in between.
