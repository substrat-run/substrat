// The plain scope behind the lockdown preamble. The preamble is imported first, so it runs before
// plain.mjs and exits.js evaluate — the best case a preamble can have.
import './lockdown.mjs';
export { default, PlainScope } from './plain.mjs';
