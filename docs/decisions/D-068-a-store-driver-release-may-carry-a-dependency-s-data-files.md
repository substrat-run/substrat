---
id: D-68
date: 2026-11-01
layer: plan
title: "A store-driver release may carry a dependency's data files beside its modules"
status: proposed
aliases: []
amends: ["D-63"]
tracking: ["#2300", "#2390"]
---

# D-68 — A store-driver release may carry a dependency's data files beside its modules

> **Proposed 2026-11-01, not ratified.** Written with the graph driver's first release, which does not
> fit the 1000-module limit without hiding files in an archive. It asks for a choice between the options
> below; the proposers prefer the first.

## The problem

A Python release ships its dependencies as `python_modules/<path>` Data modules, and D-63 keeps the
limits at 10 MiB and 1000 modules ([#2390](https://github.com/substrat-run/substrat/issues/2390)). Every
file counts as one module, whether it is code or data.

The graph driver's release is 692 modules and 7.2 MB once installer output, metadata, type stubs and
package test suites are left out. One dependency does not fit: `tzdata`, the IANA time zone database,
is 627 files. Pyodide ships no zone data, the driver's date library resolves `UTC` as it is imported,
and a rule may name any zone, so the data has to ship whole. With it the release is about 1 320 modules
and well under 10 MiB.

## Options

1. **Count only Python code toward the module limit (preferred).** A `.py` file counts as a module; any
   other file in `python_modules/` counts toward the byte limit only. The module rule still validates
   every path by name, so data files stay visible to the reviewer one by one. The limit keeps bounding
   what the reviewer must read as code, which is its purpose.
2. **Raise the module limit,** for example to 2000, and keep counting every file. Simplest to implement;
   it bounds nothing new, but it treats 600 data files as if they were 600 modules to review.
3. **Considered and not recommended: pack the data into one archive.** The driver ships
   `python_modules/tzdata.zip` and adds it to `sys.path` when it starts. It fits today's rule, and the
   archive can be built byte for byte the same each time. It is not recommended because the module rule
   judges names, and an archive is one name whose content the rule never sees: anything, code included,
   could be placed in it and imported, and only a reviewer who unpacks and compares it would notice. A
   release format should not depend on that.

## Consequences

- With option 1 or 2, `classifyPythonStoreModule` and the upload's count follow the chosen rule, and
  D-63's sentence on the limits is amended.
- The graph driver's release then ships `tzdata` as plain files, and its packer writes no archive.
