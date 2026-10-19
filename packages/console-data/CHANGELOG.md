# @substrat-run/console-data

## 0.1.1

### Patch Changes

- Updated dependencies [482e9b7]
- Updated dependencies [482e9b7]
  - @substrat-run/model-view@0.5.0
  - @substrat-run/contracts@0.152.0

## 0.1.0

### Minor Changes

- 2421450: A new private package, `@substrat-run/console-data`: one contract the console's views read from, whether the data comes from the working tree, the hosted request record or an external tool. Reads are queries over a window, and tailing is an optional extra. Each source declares what it can answer (`tail`, `rawPayloads`, `exactFacetCounts`, `traceSteps`, `model`, `permissions`, and the request fields it fills), and `negotiate` tells a view whether to draw in full, draw and mark what is missing, or say why it cannot. The local source reads `model.json`, the declared lifecycles, `PERMISSIONS.md` and any trace reader, and strips bound SQL values unless asked to keep them. A contract suite holds every source to what it declares.

### Patch Changes

- Updated dependencies [8273013]
- Updated dependencies [4efc88d]
- Updated dependencies [55c961b]
- Updated dependencies [a667881]
- Updated dependencies [f614b00]
  - @substrat-run/contracts@0.151.0
  - @substrat-run/model-view@0.4.0
