/**
 * The gates a scaffolded project ships with. `tools/scaffold-check.mjs` runs every one against a
 * real scaffold, and `tools/review-checklist.mjs` holds the review checklist's scaffold commands
 * to this list, so the two cannot name different gates.
 */
export const GATES = [
  { name: 'npm test', argv: ['test'] },
  { name: 'npm run typecheck', argv: ['run', 'typecheck'] },
  { name: 'npm run lint:boundaries', argv: ['run', 'lint:boundaries'] },
];
