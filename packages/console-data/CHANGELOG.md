# @substrat-run/console-data

## 0.1.7

### Patch Changes

- @substrat-run/contracts@0.158.0
- @substrat-run/model-view@0.6.5

## 0.1.6

### Patch Changes

- Updated dependencies [d0af665]
- Updated dependencies [156febd]
  - @substrat-run/contracts@0.157.0
  - @substrat-run/model-view@0.6.4

## 0.1.5

### Patch Changes

- Updated dependencies [c5052f9]
- Updated dependencies [1344288]
  - @substrat-run/contracts@0.156.0
  - @substrat-run/model-view@0.6.3

## 0.1.4

### Patch Changes

- Updated dependencies [6933146]
- Updated dependencies [35bdba2]
  - @substrat-run/contracts@0.155.0
  - @substrat-run/model-view@0.6.2

## 0.1.3

### Patch Changes

- Updated dependencies [bf18880]
- Updated dependencies [34c4455]
- Updated dependencies [1872bb7]
  - @substrat-run/contracts@0.154.0
  - @substrat-run/model-view@0.6.1

## 0.1.2

### Patch Changes

- Updated dependencies [17e7841]
  - @substrat-run/model-view@0.6.0
  - @substrat-run/contracts@0.153.0

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
