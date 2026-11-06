---
name: review
description: Review the current Substrat vertical change against Substrat's own rules (scope isolation, permission checks, generated files, migration losses, personal data, lifecycles, secrets, tests). Run it before pushing a vertical change or opening a PR, after the editor's built-in review. Use when asked to review, check or audit a change to a Substrat vertical.
---

# Review a change against the Substrat checklist

The editor's own review finds compile errors, logic bugs and generic security issues. This
finds the failures that look like success on a Substrat vertical: a query around the
kernel, an operation with no permission check, a hand-edit to a generated file, a migration
that drops data. Run it **after** the built-in review, before you push.

Two files in the plugin's `review/` directory, beside this skill's own directory, hold
everything; read both in full first:

- [`review/checklist.md`](../../review/checklist.md): the rules and the report shape.
- [`review/procedure.md`](../../review/procedure.md): how to apply them, what you never do,
  and how to compute the rules digest the report's headline carries.

They are the only copies. This skill adds nothing to them, and every other runner, a review the
platform hosts included, follows the same two files.
