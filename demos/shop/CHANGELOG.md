# @substrat-run/demo-shop

## 0.0.74

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/adapter-sqlite@0.75.0
  - @substrat-run/engine-invoicing@0.7.2
  - @substrat-run/contracts@0.75.0

## 0.0.73

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/engine-invoicing@0.7.1
  - @substrat-run/adapter-sqlite@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.0.72

### Patch Changes

- Updated dependencies [da69ef5]
- Updated dependencies [3b8533d]
  - @substrat-run/engine-invoicing@0.7.0
  - @substrat-run/contracts@0.73.0
  - @substrat-run/adapter-sqlite@0.73.0
  - @substrat-run/kernel@0.73.0

## 0.0.71

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/kernel@0.72.0
  - @substrat-run/adapter-sqlite@0.72.0
  - @substrat-run/contracts@0.72.0
  - @substrat-run/engine-invoicing@0.6.3

## 0.0.70

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/engine-invoicing@0.6.2
  - @substrat-run/adapter-sqlite@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.0.69

### Patch Changes

- ef4a747: The four demos that predate the model phase declare their entities.

  Every demo now has a registry and a checked-in `model.json`; `lint:model` covers
  six models instead of two. Entity names in `attachmentTargets` and relation edges
  are checked, and local `entityRelations` are DERIVED from the entities' own
  `parents` rather than written twice — shop's `variant → product` and
  `order → customer` both fall out of the declaration.

  Cross-engine edges are checked too, now that every engine exports a registry:
  meridian's `protocol → employee` against engine-protocol, rally's
  `reservation → member` against engine-booking.

  This is the entity half only. Declaring each demo's operations is a much larger
  piece — meridian alone has ~20 — and its main payoff (declared returns for a
  lane fork) is not needed yet.

  Two things worth recording, both found by doing this rather than assuming:

  **Meridian emits about an entity with no table.** `payroll-run` is an entity type
  with an id minted at emit time and no row anywhere — an event about an
  occurrence, not a stored thing. `EntityDef` requires a table, so the registry
  cannot describe it. Harmless for the entity half; it will bite when operations
  are declared, because `emits.entity` is checked against the registry.

  **Manyfold creates tables at runtime.** A content type builds its own `ct_<key>`
  table when it is defined, so those names do not exist at build time and a
  registry keyed by static table names has nothing to say about them. They are also
  not entities: the ENTRY is the thing, and its typed fields live in its `ct_` row.

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/engine-invoicing@0.6.1
  - @substrat-run/adapter-sqlite@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.0.68

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/engine-invoicing@0.6.0
  - @substrat-run/adapter-sqlite@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.0.67

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/kernel@0.68.0
  - @substrat-run/adapter-sqlite@0.68.0
  - @substrat-run/engine-invoicing@0.5.24

## 0.0.66

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0
  - @substrat-run/engine-invoicing@0.5.23
  - @substrat-run/adapter-sqlite@0.67.0

## 0.0.65

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/adapter-sqlite@0.66.0
  - @substrat-run/engine-invoicing@0.5.22
  - @substrat-run/contracts@0.66.0

## 0.0.64

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/engine-invoicing@0.5.21
  - @substrat-run/adapter-sqlite@0.65.0
  - @substrat-run/kernel@0.65.0

## 0.0.63

### Patch Changes

- Updated dependencies [c19e371]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0
  - @substrat-run/adapter-sqlite@0.64.0
  - @substrat-run/engine-invoicing@0.5.20

## 0.0.62

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/adapter-sqlite@0.63.0
  - @substrat-run/engine-invoicing@0.5.19
  - @substrat-run/contracts@0.63.0

## 0.0.61

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/engine-invoicing@0.5.18
  - @substrat-run/adapter-sqlite@0.62.0
  - @substrat-run/kernel@0.62.0

## 0.0.60

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/engine-invoicing@0.5.17
  - @substrat-run/adapter-sqlite@0.61.0
  - @substrat-run/kernel@0.61.0

## 0.0.59

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/adapter-sqlite@0.60.0
  - @substrat-run/engine-invoicing@0.5.16
  - @substrat-run/kernel@0.60.0

## 0.0.58

### Patch Changes

- @substrat-run/contracts@0.59.0
- @substrat-run/kernel@0.59.0
- @substrat-run/adapter-sqlite@0.59.0
- @substrat-run/engine-invoicing@0.5.15

## 0.0.57

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0
  - @substrat-run/adapter-sqlite@0.58.0
  - @substrat-run/engine-invoicing@0.5.14

## 0.0.56

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/engine-invoicing@0.5.13
  - @substrat-run/adapter-sqlite@0.57.0
  - @substrat-run/kernel@0.57.0

## 0.0.55

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0
  - @substrat-run/adapter-sqlite@0.56.0
  - @substrat-run/engine-invoicing@0.5.12

## 0.0.54

### Patch Changes

- @substrat-run/contracts@0.55.0
- @substrat-run/kernel@0.55.0
- @substrat-run/adapter-sqlite@0.55.0
- @substrat-run/engine-invoicing@0.5.11

## 0.0.53

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [6ecb3c9]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0
  - @substrat-run/adapter-sqlite@0.54.0
  - @substrat-run/engine-invoicing@0.5.10

## 0.0.52

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/adapter-sqlite@0.53.0
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0
  - @substrat-run/engine-invoicing@0.5.9

## 0.0.51

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/engine-invoicing@0.5.8
  - @substrat-run/adapter-sqlite@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.0.50

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0
- @substrat-run/adapter-sqlite@0.51.0
- @substrat-run/engine-invoicing@0.5.7

## 0.0.49

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [0061325]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/adapter-sqlite@0.50.0
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0
  - @substrat-run/engine-invoicing@0.5.6

## 0.0.48

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/engine-invoicing@0.5.5
  - @substrat-run/adapter-sqlite@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.0.47

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0
  - @substrat-run/adapter-sqlite@0.48.0
  - @substrat-run/engine-invoicing@0.5.4

## 0.0.46

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [0e48b8f]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/adapter-sqlite@0.47.0
  - @substrat-run/contracts@0.47.0
  - @substrat-run/engine-invoicing@0.5.3

## 0.0.45

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0
- @substrat-run/adapter-sqlite@0.46.0
- @substrat-run/engine-invoicing@0.5.2

## 0.0.44

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/adapter-sqlite@0.45.0
  - @substrat-run/engine-invoicing@0.5.1
  - @substrat-run/kernel@0.45.0

## 0.0.43

### Patch Changes

- Updated dependencies [3246681]
- Updated dependencies [2314d79]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/adapter-sqlite@0.44.0
  - @substrat-run/engine-invoicing@0.5.0
  - @substrat-run/contracts@0.44.0

## 0.0.42

### Patch Changes

- @substrat-run/contracts@0.43.0
- @substrat-run/kernel@0.43.0
- @substrat-run/adapter-sqlite@0.43.0
- @substrat-run/engine-invoicing@0.4.3

## 0.0.41

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/adapter-sqlite@0.42.0
  - @substrat-run/engine-invoicing@0.4.2
  - @substrat-run/contracts@0.42.0

## 0.0.40

### Patch Changes

- Updated dependencies [e9c7bd0]
- Updated dependencies [d222905]
  - @substrat-run/adapter-sqlite@0.41.0
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0
  - @substrat-run/engine-invoicing@0.4.1

## 0.0.39

### Patch Changes

- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [5a9d7bd]
- Updated dependencies [d59a515]
  - @substrat-run/kernel@0.40.0
  - @substrat-run/adapter-sqlite@0.40.0
  - @substrat-run/contracts@0.40.0
  - @substrat-run/engine-invoicing@0.4.0

## 0.0.38

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/adapter-sqlite@0.39.0
  - @substrat-run/engine-invoicing@0.3.37
  - @substrat-run/kernel@0.39.0

## 0.0.37

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0
  - @substrat-run/adapter-sqlite@0.38.0
  - @substrat-run/engine-invoicing@0.3.36

## 0.0.36

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/kernel@0.37.0
- @substrat-run/adapter-sqlite@0.37.0
- @substrat-run/engine-invoicing@0.3.35

## 0.0.35

### Patch Changes

- @substrat-run/contracts@0.36.0
- @substrat-run/kernel@0.36.0
- @substrat-run/adapter-sqlite@0.36.0
- @substrat-run/engine-invoicing@0.3.34

## 0.0.34

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/engine-invoicing@0.3.33
  - @substrat-run/adapter-sqlite@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.0.33

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0
  - @substrat-run/adapter-sqlite@0.34.0
  - @substrat-run/engine-invoicing@0.3.32

## 0.0.32

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0
  - @substrat-run/adapter-sqlite@0.33.0
  - @substrat-run/engine-invoicing@0.3.31

## 0.0.31

### Patch Changes

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0
  - @substrat-run/adapter-sqlite@0.32.0
  - @substrat-run/engine-invoicing@0.3.30

## 0.0.30

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/kernel@0.31.0
  - @substrat-run/adapter-sqlite@0.31.0
  - @substrat-run/engine-invoicing@0.3.29

## 0.0.29

### Patch Changes

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
- Updated dependencies [91a60e2]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0
  - @substrat-run/adapter-sqlite@0.30.0
  - @substrat-run/engine-invoicing@0.3.28

## 0.0.28

### Patch Changes

- @substrat-run/contracts@0.29.0
- @substrat-run/kernel@0.29.0
- @substrat-run/adapter-sqlite@0.29.0
- @substrat-run/engine-invoicing@0.3.27

## 0.0.27

### Patch Changes

- @substrat-run/contracts@0.28.0
- @substrat-run/kernel@0.28.0
- @substrat-run/adapter-sqlite@0.28.0
- @substrat-run/engine-invoicing@0.3.26

## 0.0.26

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0
  - @substrat-run/adapter-sqlite@0.27.0
  - @substrat-run/engine-invoicing@0.3.25

## 0.0.25

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0
  - @substrat-run/adapter-sqlite@0.26.0
  - @substrat-run/engine-invoicing@0.3.24

## 0.0.24

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0
  - @substrat-run/adapter-sqlite@0.25.0
  - @substrat-run/engine-invoicing@0.3.23

## 0.0.23

### Patch Changes

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0
  - @substrat-run/adapter-sqlite@0.24.0
  - @substrat-run/engine-invoicing@0.3.22

## 0.0.22

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/engine-invoicing@0.3.21
  - @substrat-run/adapter-sqlite@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.0.21

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0
  - @substrat-run/adapter-sqlite@0.22.0
  - @substrat-run/engine-invoicing@0.3.20

## 0.0.20

### Patch Changes

- @substrat-run/contracts@0.21.0
- @substrat-run/kernel@0.21.0
- @substrat-run/adapter-sqlite@0.21.0
- @substrat-run/engine-invoicing@0.3.19

## 0.0.19

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0
  - @substrat-run/adapter-sqlite@0.20.0
  - @substrat-run/engine-invoicing@0.3.18

## 0.0.18

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/kernel@0.19.0
  - @substrat-run/adapter-sqlite@0.19.0
  - @substrat-run/engine-invoicing@0.3.17

## 0.0.17

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0
  - @substrat-run/adapter-sqlite@0.18.0
  - @substrat-run/engine-invoicing@0.3.16

## 0.0.16

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0
- @substrat-run/adapter-sqlite@0.17.0
- @substrat-run/engine-invoicing@0.3.15

## 0.0.15

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0
  - @substrat-run/adapter-sqlite@0.16.0
  - @substrat-run/engine-invoicing@0.3.14

## 0.0.14

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/adapter-sqlite@0.15.0
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0
  - @substrat-run/engine-invoicing@0.3.13

## 0.0.13

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-sqlite@0.14.0
  - @substrat-run/engine-invoicing@0.3.11
  - @substrat-run/kernel@0.14.0

## 0.0.12

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/kernel@0.13.0
  - @substrat-run/adapter-sqlite@0.13.0
  - @substrat-run/contracts@0.13.0
  - @substrat-run/engine-invoicing@0.3.10

## 0.0.11

### Patch Changes

- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [66e752b]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/adapter-sqlite@0.12.0
  - @substrat-run/kernel@0.12.0
  - @substrat-run/engine-invoicing@0.3.9

## 0.0.10

### Patch Changes

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/adapter-sqlite@0.11.0
  - @substrat-run/contracts@0.11.0
  - @substrat-run/engine-invoicing@0.3.8

## 0.0.9

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0
  - @substrat-run/adapter-sqlite@0.10.0
  - @substrat-run/engine-invoicing@0.3.7

## 0.0.8

### Patch Changes

- Updated dependencies [27872cc]
  - @substrat-run/kernel@0.9.0
  - @substrat-run/adapter-sqlite@0.9.0
  - @substrat-run/engine-invoicing@0.3.6
  - @substrat-run/contracts@0.9.0

## 0.0.7

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0
- @substrat-run/adapter-sqlite@0.8.0
- @substrat-run/engine-invoicing@0.3.5

## 0.0.6

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0
  - @substrat-run/adapter-sqlite@0.7.0
  - @substrat-run/engine-invoicing@0.3.4

## 0.0.5

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0
- @substrat-run/adapter-sqlite@0.6.0
- @substrat-run/engine-invoicing@0.3.2

## 0.0.4

### Patch Changes

- @substrat-run/contracts@0.5.0
- @substrat-run/kernel@0.5.0
- @substrat-run/adapter-sqlite@0.5.0
- @substrat-run/engine-invoicing@0.3.1

## 0.0.3

### Patch Changes

- Updated dependencies [6900431]
- Updated dependencies [7e9fad6]
  - @substrat-run/contracts@0.4.0
  - @substrat-run/kernel@0.4.0
  - @substrat-run/adapter-sqlite@0.4.0
  - @substrat-run/engine-invoicing@0.3.0

## 0.0.2

### Patch Changes

- Updated dependencies [5dd4085]
  - @substrat-run/contracts@0.3.0
  - @substrat-run/kernel@0.3.0
  - @substrat-run/adapter-sqlite@0.3.0
  - @substrat-run/engine-invoicing@0.2.0
