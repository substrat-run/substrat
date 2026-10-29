# @substrat-run/console-data

## 0.1.15

### Patch Changes

- Updated dependencies [9499b29]
  - @substrat-run/contracts@0.166.0
  - @substrat-run/model-view@0.6.13

## 0.1.14

### Patch Changes

- Updated dependencies [7df34ee]
  - @substrat-run/contracts@0.165.0
  - @substrat-run/model-view@0.6.12

## 0.1.13

### Patch Changes

- Updated dependencies [170078f]
- Updated dependencies [3225234]
- Updated dependencies [0b19237]
- Updated dependencies [1e5a5af]
  - @substrat-run/contracts@0.164.0
  - @substrat-run/model-view@0.6.11

## 0.1.12

### Patch Changes

- Updated dependencies [2eedfee]
  - @substrat-run/contracts@0.163.0
  - @substrat-run/model-view@0.6.10

## 0.1.11

### Patch Changes

- Updated dependencies [7d71f13]
  - @substrat-run/contracts@0.162.0
  - @substrat-run/model-view@0.6.9

## 0.1.10

### Patch Changes

- Updated dependencies [7d34c2c]
- Updated dependencies [8bb7be5]
- Updated dependencies [81a07aa]
- Updated dependencies [14ce171]
  - @substrat-run/contracts@0.161.0
  - @substrat-run/model-view@0.6.8

## 0.1.9

### Patch Changes

- Updated dependencies [8e8af88]
- Updated dependencies [f0b5904]
- Updated dependencies [763957c]
- Updated dependencies [361136b]
- Updated dependencies [dc3b911]
- Updated dependencies [a283098]
- Updated dependencies [95bdb79]
- Updated dependencies [69868f3]
- Updated dependencies [ee05879]
- Updated dependencies [78a0c96]
- Updated dependencies [09c081a]
- Updated dependencies [ecbed6e]
- Updated dependencies [bc36021]
- Updated dependencies [286f3b4]
- Updated dependencies [5f75359]
- Updated dependencies [bc629db]
  - @substrat-run/contracts@0.160.0
  - @substrat-run/model-view@0.6.7

## 0.1.8

### Patch Changes

- Updated dependencies [6aad0fb]
  - @substrat-run/contracts@0.159.0
  - @substrat-run/model-view@0.6.6

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
